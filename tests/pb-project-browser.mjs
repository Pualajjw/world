import { checkPluginRoots } from './roots-browser.mjs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { browserLaunchOptions } from '../../pbpkg/tests/browser-state.js'

const root = join(import.meta.dirname, '..'), require = createRequire(join(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true, format: 'iife',
  platform: 'browser', target: 'es2022', write: false, nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
const browser = await chromium.launch(browserLaunchOptions())
try { await checkPluginRoots(browser, bundle.outputFiles[0].text) } finally { await browser.close() }
