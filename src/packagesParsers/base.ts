import fs from 'fs'
import path from 'path'
import { File, Log } from '~/utils'

export abstract class PackageParser {
  static filename: string

  static load(root: string) {
    const packageFilepaths = new Set<string>()
    const rootPackageFilepath = path.join(root, this.filename)
    if (fs.existsSync(rootPackageFilepath))
      packageFilepaths.add(rootPackageFilepath)

    function traverseDirectory(subdir: string, filename: string, ignoreDirectories: string[] = []) {
      const packageFilepath = path.join(subdir, filename)
      if (fs.existsSync(packageFilepath))
        packageFilepaths.add(packageFilepath)

      const subdirs = fs
        .readdirSync(subdir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory() && !ignoreDirectories.includes(dirent.name))
        .map(dirent => path.join(subdir, dirent.name))
      for (const subdir of subdirs)
        traverseDirectory(subdir, filename, ignoreDirectories)
    }

    traverseDirectory(root, this.filename, this.ignoreDirectories())

    if (packageFilepaths.size === 0) {
      Log.info(`🕳 Packages file "${this.filename}" not exists`)
      return undefined
    }

    Log.info(`📦 Packages file "${this.filename}" found`)

    try {
      const data: string[] = []
      for (const filepath of packageFilepaths) {
        const raw = this.loadFile(filepath)
        data.push(...this.parserRaw(raw))
      }
      return data
    }
    catch (err) {
      Log.info(`⚠ Error on parsing package file "${this.filename}" within folder tree of "${root}"`)
    }

    return undefined
  }

  protected static loadFile(filepath: string) {
    return File.readSync(filepath)
  }

  protected static ignoreDirectories() {
    return ['.git']
  }

  protected static parserRaw(raw: string) {
    const {
      dependencies = {},
      devDependencies = {},
      peerDependencies = {},
    } = JSON.parse(raw)

    return [...Object.keys(dependencies), ...Object.keys(devDependencies), ...Object.keys(peerDependencies)]
  }
}
