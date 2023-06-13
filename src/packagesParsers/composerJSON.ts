import { PackageParser } from './base'

export class ComposerJSONParser extends PackageParser {
  static filename = 'composer.json'

  protected static ignoreDirectories(): string[] {
    return ['vendor', '.git']
  }

  protected static parserRaw(raw: string) {
    const {
      require = {},
    } = JSON.parse(raw)

    return Object.keys(require)
  }
}
