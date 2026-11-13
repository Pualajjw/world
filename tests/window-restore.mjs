import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Reopening a running app must preserve its state and its normal rectangle. */
export async function checkWindowRestore(page, appWindow, id, reopenFromStart) {
  const taskbar = page.locator(`[data-world-taskbar="${id}"]`)
  const bounds = () => appWindow.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(rect[key])]))
  })
  const normal = await bounds()
  await appWindow.getByRole('button', { name: '最大化', exact: true }).click()
  const maximized = await bounds()
  assert.deepEqual(maximized, { x: 0, y: 40, width: 1280, height: 712 }, `${id}: fills the existing desktop area`)

  // 点已经在前台的窗口 = 收回任务栏（Windows 的手感）；再点一次，最大化状态还在
  await taskbar.click()
  assert.equal(await appWindow.isVisible(), false,
    `${id}: clicking the active taskbar item minimizes the window`)
  assert.equal(await taskbar.evaluate(element => element.classList.contains('is-min')), true)
  await taskbar.click()
  assert.equal(await appWindow.evaluate(element => element.classList.contains('is-max')), true,
    `${id}: coming back from the taskbar keeps it maximized`)
  assert.deepEqual(await bounds(), maximized)

  const minimizeAndRestore = async restore => {
    await appWindow.getByRole('button', { name: '最小化', exact: true }).click()
    assert.equal(await appWindow.isVisible(), false)
    assert.equal(await taskbar.evaluate(element => element.classList.contains('is-min')), true)
    await restore()
    assert.equal(await appWindow.isVisible(), true)
    assert.equal(await taskbar.evaluate(element => element.classList.contains('is-min')), false)
    assert.equal(await page.locator('body').getAttribute('data-world-active-window'), id)
  }

  await minimizeAndRestore(() => taskbar.click())
  assert.equal(await appWindow.evaluate(element => element.classList.contains('is-max')), true,
    `${id}: taskbar restores the maximized state`)
  assert.deepEqual(await bounds(), maximized)
  const shots = process.env.WORLD_RESTORE_SHOTS_DIR
  if (shots) {
    await mkdir(shots, { recursive: true })
    await page.screenshot({ path: join(shots, `desktop-restore-${id.replaceAll(':', '-')}.png`), animations: 'disabled' })
  }

  await minimizeAndRestore(reopenFromStart)
  assert.equal(await appWindow.evaluate(element => element.classList.contains('is-max')), true,
    `${id}: the start menu also restores the maximized state`)
  assert.deepEqual(await bounds(), maximized)
  assert.equal(await appWindow.count(), 1, `${id}: reopening reuses the existing window`)

  await appWindow.getByRole('button', { name: '还原', exact: true }).click()
  assert.deepEqual(await bounds(), normal, `${id}: the restore button returns to the original rectangle`)
  await minimizeAndRestore(() => taskbar.click())
  assert.equal(await appWindow.evaluate(element => element.classList.contains('is-max')), false,
    `${id}: normal windows remain normal after a later minimize/restore`)
  assert.deepEqual(await bounds(), normal)
  console.log(`Window restore ${id}: normal ${JSON.stringify(normal)}; maximized/taskbar/start ${JSON.stringify(maximized)}.`)
}
