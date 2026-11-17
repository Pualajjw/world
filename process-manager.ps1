param([int]$RootProcessId, [ValidateSet('Snapshot','Files','Ports')][string]$Mode = 'Snapshot', [string]$TargetFileBase64)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Get-WorldTree {
  # Only parent links are discovered system-wide; resource metrics are read solely for this DSH tree.
  $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate)
  $selected = @{}
  $root = $all | Where-Object { $_.ProcessId -eq $RootProcessId } | Select-Object -First 1
  if (-not $root) { throw 'DSH root process is no longer available.' }
  $selected[[int]$root.ProcessId] = $root
  do {
    $changed = $false
    foreach ($item in $all) {
      $parent = $selected[[int]$item.ParentProcessId]
      if (-not $selected.ContainsKey([int]$item.ProcessId) -and $parent -and $item.CreationDate -ge $parent.CreationDate) {
        $selected[[int]$item.ProcessId] = $item; $changed = $true
      }
    }
  } while ($changed)
  $rows = @()
  foreach ($item in $selected.Values) {
    $cpu = $null; $memory = $null; $private = $null; $handles = $null; $threads = $null; $exePath = ''
    $startedAt = $item.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()
    try {
      $p = Get-Process -Id $item.ProcessId -ErrorAction Stop
      # Sampling helpers are implementation details, not application workload.
      if ($p.Id -eq $PID) { continue }
      $memory = $p.WorkingSet64; $private = $p.PrivateMemorySize64; $handles = $p.HandleCount
      try { $cpu = $p.TotalProcessorTime.TotalMilliseconds } catch {}
      try { $threads = $p.Threads.Count } catch {}
      try { $exePath = $p.Path } catch {}
      try { $startedAt = $p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() } catch {}
      $p.Dispose()
    } catch { continue }
    $rows += [ordered]@{ pid = [int]$item.ProcessId; parentPid = [int]$item.ParentProcessId
      name = [string]$item.Name; startedAt = $startedAt
      cpuMs = $cpu; workingSet = $memory; privateBytes = $private; handles = $handles; threads = $threads; path = $exePath }
  }
  return $rows
}

try {
  $owners = @()
  if ($Mode -eq 'Files') {
    $targetFile = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TargetFileBase64))
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using FILETIME = System.Runtime.InteropServices.ComTypes.FILETIME;
public static class WorldFileOwners {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint pid; public FILETIME start; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string service;
    public uint type, status, session;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint session, int flags, string key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint session, uint files, string[] names, uint apps, UniqueProcess[] processes, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session, out uint needed, ref uint count, [In,Out] ProcessInfo[] items, ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  public static ProcessInfo[] Query(string path) {
    uint session; int code = RmStartSession(out session, 0, Guid.NewGuid().ToString("N"));
    if (code != 0) throw new Exception("Restart Manager: " + code);
    try {
      code = RmRegisterResources(session, 1, new string[]{path}, 0, null, 0, null);
      if (code != 0) throw new Exception("Register resource: " + code);
      for (int attempt=0; attempt<4; attempt++) {
        uint needed, count=0, reasons=0;
        code = RmGetList(session, out needed, ref count, null, ref reasons);
        if (code == 0) return new ProcessInfo[0];
        if (code != 234) throw new Exception("Query owners: " + code);
        ProcessInfo[] result = new ProcessInfo[needed]; count = needed;
        code = RmGetList(session, out needed, ref count, result, ref reasons);
        if (code == 234) continue;
        if (code != 0) throw new Exception("Query owners: " + code);
        Array.Resize(ref result, (int)count); return result;
      }
      throw new Exception("File owners changed during query; please retry.");
    } finally { RmEndSession(session); }
  }
  public static string StartTime(ProcessInfo item) {
    return (((ulong)(uint)item.process.start.dwHighDateTime << 32) | (uint)item.process.start.dwLowDateTime).ToString();
  }
}
'@
    $rawOwners = @([WorldFileOwners]::Query($targetFile))
  }
  $rows = @(Get-WorldTree)
  $ports = @()
  if ($Mode -eq 'Ports') {
    $allowed = @{}; foreach ($row in $rows) { $allowed[[int]$row.pid] = $row }
    foreach ($endpoint in @(Get-NetTCPConnection -ErrorAction Stop)) {
      $owner = $allowed[[int]$endpoint.OwningProcess]
      if ($owner) {
        $ports += [ordered]@{ pid = $owner.pid; startedAt = $owner.startedAt; protocol = 'TCP'
          localAddress = [string]$endpoint.LocalAddress; localPort = [int]$endpoint.LocalPort
          remoteAddress = [string]$endpoint.RemoteAddress; remotePort = [int]$endpoint.RemotePort; state = [string]$endpoint.State }
      }
    }
    foreach ($endpoint in @(Get-NetUDPEndpoint -ErrorAction Stop)) {
      $owner = $allowed[[int]$endpoint.OwningProcess]
      if ($owner) {
        $ports += [ordered]@{ pid = $owner.pid; startedAt = $owner.startedAt; protocol = 'UDP'
          localAddress = [string]$endpoint.LocalAddress; localPort = [int]$endpoint.LocalPort
          remoteAddress = ''; remotePort = 0; state = 'BOUND' }
      }
    }
    $after = @{}; foreach ($row in @(Get-WorldTree)) { $after[[string]$row.pid + ':' + $row.startedAt] = $true }
    $ports = @($ports | Where-Object { $after.ContainsKey([string]$_.pid + ':' + $_.startedAt) })
  }
  if ($Mode -eq 'Files') {
    foreach ($owner in $rawOwners) {
      $started = [WorldFileOwners]::StartTime($owner)
      # Match creation time too, so a recycled PID can never escape the DSH scope.
      $match = $rows | Where-Object { $_.pid -eq $owner.process.pid -and $_.startedAt -eq $started } | Select-Object -First 1
      if ($match) { $owners += @{ pid = [int]$owner.process.pid; startedAt = $started } }
    }
  }
  [ordered]@{ timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); cores = [Environment]::ProcessorCount
    rows = @($rows); owners = @($owners); ports = @($ports) } | ConvertTo-Json -Depth 6 -Compress
} catch {
  @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
