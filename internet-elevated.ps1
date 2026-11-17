param([Parameter(Mandatory=$true)][string]$PipeName, [Parameter(Mandatory=$true)][string]$Token)
$ErrorActionPreference = 'Stop'
$pipe = $null; $core = $null; $writer = $null; $reader = $null; $jobHandle = [IntPtr]::Zero
function Send-WorldMessage($value) { $writer.WriteLine(($value | ConvertTo-Json -Compress -Depth 5)) }
try {
  $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
  $pipe.Connect(10000)
  $encoding = [Text.UTF8Encoding]::new($false)
  $writer = [IO.StreamWriter]::new($pipe, $encoding, 4096, $true); $writer.AutoFlush = $true
  $reader = [IO.StreamReader]::new($pipe, $encoding, $false, 4096, $true)
  Send-WorldMessage @{type='hello'; token=$Token}
  $job = $reader.ReadLine() | ConvertFrom-Json
  if ($null -eq $job) { throw 'Missing EasyTier launch configuration.' }
  if ($job.requireAdmin) {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'The EasyTier helper was not elevated.' }
  }
  # Build a Windows argv string without invoking cmd.exe or interpreting shell metacharacters.
  $quoted = foreach ($arg in $job.args) {
    $text = [string]$arg
    $text = [regex]::Replace($text, '(\\*)"', '$1$1\"')
    $text = [regex]::Replace($text, '(\\+)$', '$1$1')
    '"' + $text + '"'
  }
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = [string]$job.executable; $info.Arguments = $quoted -join ' '
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  if ($job.cwd) { $info.WorkingDirectory = [string]$job.cwd }
  $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = $encoding; $info.StandardErrorEncoding = $encoding
  $info.EnvironmentVariables['NO_COLOR'] = '1'
  # A kill-on-close Job Object also handles abrupt helper/host termination, where
  # PowerShell finally blocks cannot run. Only this launch's EasyTier is assigned.
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class WorldInternetJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic Basic; public Io Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended value, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Create() {
    var job = CreateJobObject(IntPtr.Zero, null);
    if(job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var info = new Extended(); info.Basic.Flags = 0x2000;
    if(!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(info))) {
      var error = Marshal.GetLastWin32Error(); CloseHandle(job); throw new Win32Exception(error);
    }
    return job;
  }
  public static void Attach(IntPtr job, IntPtr process) {
    if(!AssignProcessToJobObject(job, process)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
  $jobHandle = [WorldInternetJob]::Create()
  $core = [Diagnostics.Process]::new(); $core.StartInfo = $info
  [void]$core.Start()
  [WorldInternetJob]::Attach($jobHandle, $core.Handle)
  Send-WorldMessage @{type='started'; pid=$core.Id}
  $outBuffer = New-Object byte[] 4096; $errBuffer = New-Object byte[] 4096
  $outRead = $core.StandardOutput.BaseStream.ReadAsync($outBuffer, 0, $outBuffer.Length)
  $errRead = $core.StandardError.BaseStream.ReadAsync($errBuffer, 0, $errBuffer.Length)
  $command = $reader.ReadLineAsync()
  while ($true) {
    if ($command.IsCompleted) {
      $line = $command.GetAwaiter().GetResult()
      if ($null -eq $line -or ($line | ConvertFrom-Json).type -eq 'stop') {
        if (-not $core.HasExited) { $core.Kill() }
      }
      if ($null -ne $line) { $command = $reader.ReadLineAsync() }
    }
    if ($outRead -and $outRead.IsCompleted) {
      $count = $outRead.GetAwaiter().GetResult()
      if ($count -gt 0) {
        Send-WorldMessage @{type='stdout'; data=[Convert]::ToBase64String($outBuffer, 0, $count)}
        $outRead = $core.StandardOutput.BaseStream.ReadAsync($outBuffer, 0, $outBuffer.Length)
      } else { $outRead = $null }
    }
    if ($errRead -and $errRead.IsCompleted) {
      $count = $errRead.GetAwaiter().GetResult()
      if ($count -gt 0) {
        Send-WorldMessage @{type='stderr'; data=[Convert]::ToBase64String($errBuffer, 0, $count)}
        $errRead = $core.StandardError.BaseStream.ReadAsync($errBuffer, 0, $errBuffer.Length)
      } else { $errRead = $null }
    }
    if ($core.HasExited -and -not $outRead -and -not $errRead) {
      $core.WaitForExit()
      Send-WorldMessage @{type='exit'; code=$core.ExitCode}
      break
    }
    Start-Sleep -Milliseconds 20
  }
} catch {
  try { if ($writer) { Send-WorldMessage @{type='error'; message=$_.Exception.Message} } } catch {}
} finally {
  if ($core) { try { if (-not $core.HasExited) { $core.Kill(); $core.WaitForExit() } } catch {}; $core.Dispose() }
  if ($jobHandle -ne [IntPtr]::Zero) { [void][WorldInternetJob]::CloseHandle($jobHandle) }
  if ($writer) { $writer.Dispose() }; if ($reader) { $reader.Dispose() }; if ($pipe) { $pipe.Dispose() }
}
