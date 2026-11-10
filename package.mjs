/** Produce the installable universal DSH package. */
import { resolve } from 'node:path'
import { packagePlugin } from '../project-tree/package-plugin.mjs'

await packagePlugin(import.meta.dirname, { output: resolve(import.meta.dirname, 'dist'), platform: 'universal' })
