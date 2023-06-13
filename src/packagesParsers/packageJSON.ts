import { PackageParser } from './base'

export class PackageJSONParser extends PackageParser {
  static filename = 'package.json'

  protected static ignoreDirectories(): string[] {
    return ['node_modules', '.git']
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
