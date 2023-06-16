import path, { extname, resolve } from 'path'
import { workspace, commands, window, EventEmitter, Event, ExtensionContext, ConfigurationChangeEvent, TextDocument, WorkspaceFolder } from 'vscode'
import { uniq } from 'lodash'
import { slash } from '@antfu/utils'
import { isMatch } from 'micromatch'
import { ParsePathMatcher } from '../utils/PathMatcher'
import { EXT_NAMESPACE } from '../meta'
import { ConfigLocalesGuide } from '../commands/configLocalePaths'
import { AvailableParsers, DefaultEnabledParsers } from '../parsers'
import { Framework } from '../frameworks/base'
import { getEnabledFrameworks, getEnabledFrameworksByIds, getPackageDependencies } from '../frameworks'
import { checkNotification } from '../update-notification'
import { Reviews } from './Review'
import { CurrentFile } from './CurrentFile'
import { Config } from './Config'
import { DirStructure, OptionalFeatures, KeyStyle } from './types'
import { LocaleLoader } from './loaders/LocaleLoader'
import { Analyst } from './Analyst'
import { Telemetry, TelemetryKey } from './Telemetry'
import i18n from '~/i18n'
import { Log, getExtOfLanguageId, normalizeUsageMatchRegex } from '~/utils'
import { DetectionResult } from '~/core/types'

export class Global {
  private static _loaders: Record<string, LocaleLoader> = {}
  private static _currentWorkspaceRootPath: string
  private static _currentActiveFilePath: string
  private static _nearestEnabledFrameworkPath: string | undefined
  private static _enabled = false
  private static _currentWorkspaceFolder: WorkspaceFolder

  static context: ExtensionContext
  static enabledFrameworks: Framework[] = []
  static reviews = new Reviews()

  // events
  private static _onDidChangeCurrentWorkspaceRootPath: EventEmitter<string> = new EventEmitter()
  private static _onDidChangeEnabled: EventEmitter<boolean> = new EventEmitter()
  private static _onDidChangeLoader: EventEmitter<LocaleLoader> = new EventEmitter()

  static readonly onDidChangeCurrentWorkspaceRootPath: Event<string> = Global._onDidChangeCurrentWorkspaceRootPath.event
  static readonly onDidChangeEnabled: Event<boolean> = Global._onDidChangeEnabled.event
  static readonly onDidChangeLoader: Event<LocaleLoader> = Global._onDidChangeLoader.event

  static async init(context: ExtensionContext) {
    this.context = context

    context.subscriptions.push(workspace.onDidChangeWorkspaceFolders(() => this.updateRootPaths()))
    context.subscriptions.push(window.onDidChangeActiveTextEditor(() => this.updateRootPaths()))
    context.subscriptions.push(workspace.onDidOpenTextDocument(() => this.updateRootPaths()))
    context.subscriptions.push(workspace.onDidCloseTextDocument(() => this.updateRootPaths()))
    context.subscriptions.push(workspace.onDidChangeConfiguration(e => this.update({ event: e })))
    await this.updateRootPaths()
  }

  // #region framework settings
  static resetCache() {
    this._cacheUsageMatchRegex = {}
  }

  private static _cacheUsageMatchRegex: Record<string, RegExp[]> = {}

  static getUsageMatchRegex(languageId?: string, filepath?: string): RegExp[] {
    if (Config._regexUsageMatch) {
      if (!this._cacheUsageMatchRegex.custom) {
        this._cacheUsageMatchRegex.custom = normalizeUsageMatchRegex([
          ...Config._regexUsageMatch,
          ...Config._regexUsageMatchAppend,
        ])
      }
      return this._cacheUsageMatchRegex.custom
    }
    else {
      const key = `${languageId}_${filepath}`
      if (!this._cacheUsageMatchRegex[key]) {
        this._cacheUsageMatchRegex[key] = normalizeUsageMatchRegex([
          ...this.enabledFrameworks.flatMap(f => f.getUsageMatchRegex(languageId, filepath)),
          ...Config._regexUsageMatchAppend,
        ])
      }
      return this._cacheUsageMatchRegex[key]
    }
  }

  static async requestKeyStyle(): Promise<KeyStyle> {
    // user setting
    if (Config._keyStyle !== 'auto')
      return Config._keyStyle

    // try to use frameworks preference
    for (const f of this.enabledFrameworks) {
      if (f.perferredKeystyle && f.perferredKeystyle !== 'auto')
        return f.perferredKeystyle
    }

    // prompt to select
    const result = await window.showQuickPick([{
      value: 'nested',
      label: i18n.t('prompt.keystyle_nested'),
      description: i18n.t('prompt.keystyle_nested_example'),
    }, {
      value: 'flat',
      label: i18n.t('prompt.keystyle_flat'),
      description: i18n.t('prompt.keystyle_flat_example'),
    }], {
      placeHolder: i18n.t('prompt.keystyle_select'),
    })

    if (!result) {
      Config._keyStyle = 'nested'
      return 'nested'
    }
    Config._keyStyle = result.value as KeyStyle
    return result.value as KeyStyle
  }

  static interpretRefactorTemplates(keypath: string, args?: string[], document?: TextDocument, detection?: DetectionResult) {
    const path = slash(document?.uri.fsPath || '')
    const root = workspace.workspaceFolders?.[0]?.uri.fsPath
    const customTemplates = Config.refactorTemplates
      .filter((i) => {
        if (i.source && i.source !== detection?.source)
          return false
        if (i.exclude || i.include) {
          if (!path || !root)
            return false
          if (i.exclude && isMatch(path, i.exclude.map(i => slash(resolve(root, i)))))
            return false
          if (i.include && !isMatch(path, i.include.map(i => slash(resolve(root, i)))))
            return false
        }
        return true
      })
    const argsString = args?.length ? `,${args?.join(',')}` : ''

    const customReplacers = customTemplates
      .flatMap(i => i.templates)
      .map(i => i
        .replace(/{key}/, keypath)
        .replace(/{args}/, argsString),
      )

    const frameworkReplacers = this.enabledFrameworks
      .flatMap(f => f.refactorTemplates(keypath, args, document, detection))

    return uniq([
      ...customReplacers,
      ...frameworkReplacers,
    ])
  }

  static isLanguageIdSupported(languageId: string) {
    return this.enabledFrameworks
      .flatMap(f => f.languageIds as string[])
      .includes(languageId)
  }

  static getSupportLangGlob() {
    const exts = uniq(this.enabledFrameworks
      .flatMap(f => f.languageIds)
      .flatMap(id => getExtOfLanguageId(id)))

    if (!exts.length)
      return ''
    else if (exts.length === 1)
      return `**/*.${exts[0]}`
    else
      return `**/*.{${exts.join(',')}}`
  }

  static getNamespaceDelimiter() {
    for (const f of this.enabledFrameworks) {
      if (f.namespaceDelimiter)
        return f.namespaceDelimiter
    }

    return '.'
  }

  static get derivedKeyRules() {
    const rules = Config.usageDerivedKeyRules
      ? Config.usageDerivedKeyRules
      : this.enabledFrameworks
        .flatMap(f => f.derivedKeyRules || [])

    return uniq(rules)
      .map((rule) => {
        const reg = rule
          .replace(/\./g, '\\.')
          .replace(/{key}/, '(.+)')

        return new RegExp(`^${reg}$`)
      })
  }

  static getDocumentSelectors() {
    return this.enabledFrameworks
      .flatMap(f => f.languageIds)
      .map(id => ({ scheme: 'file', language: id }))
  }

  static get enabledParserExts() {
    return this.enabledParsers
      .flatMap(f => [
        f.supportedExts,
        Object.entries(Config.parsersExtendFileExtensions)
          .find(([, v]) => v === f.id)?.[0],
      ])
      .filter(Boolean)
      .join('|')
  }

  static get dirStructure() {
    let config = Config._dirStructure
    if (!config || config === 'auto') {
      for (const f of this.enabledFrameworks) {
        if (f.perferredDirStructure)
          config = f.perferredDirStructure
      }
    }
    return config
  }

  static getPathMatchers(dirStructure: DirStructure) {
    const rules = Config._pathMatcher
      ? [Config._pathMatcher]
      : this.enabledFrameworks
        .flatMap(f => f.pathMatcher(dirStructure))

    return uniq(rules)
      .map(matcher => ({
        regex: ParsePathMatcher(matcher, this.enabledParserExts),
        matcher,
      }))
  }

  static hasFeatureEnabled(name: keyof OptionalFeatures) {
    return this.enabledFrameworks
      .map(i => i.enableFeatures)
      .filter(i => i)
      .some(i => i && i[name])
  }

  static get namespaceEnabled() {
    return Config.namespace || this.hasFeatureEnabled('namespace')
  }

  static get localesPaths(): string[] | undefined {
    let config

    if (this._currentWorkspaceFolder)
      config = Config.getLocalesPathsInScope(this._currentWorkspaceFolder)
    else
      config = Config._localesPaths

    if (!config) {
      config = this.enabledFrameworks.flatMap(f => f.perferredLocalePaths || [])
      if (!config.length)
        config = undefined
    }
    return config
  }

  // #endregion

  static get currentWorkspaceRootPath() {
    return this._currentWorkspaceRootPath
  }

  static get currentActiveFilePath() {
    return this._currentActiveFilePath
  }

  static get nearestEnabledFrameworkPath() {
    return this._nearestEnabledFrameworkPath
  }

  private static async initLoader(folderPath: string, reload = false) {
    if (!folderPath)
      return

    // if (Config.debug)
    //  clearNotificationState(this.context)
    checkNotification(this.context)

    if (this._loaders[folderPath] && !reload)
      return this._loaders[folderPath]

    const loader = new LocaleLoader(folderPath)
    await loader.init()
    this.context.subscriptions.push(loader.onDidChange(() => this._onDidChangeLoader.fire(loader)))
    this.context.subscriptions.push(loader)
    this._loaders[folderPath] = loader

    return this._loaders[folderPath]
  }

  private static async updateRootPaths() {
    const editor = window.activeTextEditor
    let currentWorkspaceRootPath = ''
    let currentActiveFilePath = ''
    let updateNeeded = false

    if (!editor || !workspace.workspaceFolders || workspace.workspaceFolders.length === 0)
      return

    const resource = editor.document.uri
    if (resource.scheme === 'file') {
      const folder = workspace.getWorkspaceFolder(resource)
      if (folder) {
        this._currentWorkspaceFolder = folder
        currentWorkspaceRootPath = folder.uri.fsPath
      }
      currentActiveFilePath = path.dirname(resource.fsPath)
    }

    if (!currentWorkspaceRootPath && workspace.rootPath)
      currentWorkspaceRootPath = workspace.rootPath

    if (currentWorkspaceRootPath && currentWorkspaceRootPath !== this._currentWorkspaceRootPath) {
      this._currentWorkspaceRootPath = currentWorkspaceRootPath

      Log.divider()
      Log.info(`💼 Workspace root changed to "${currentWorkspaceRootPath}"`)
      updateNeeded = true
      this._onDidChangeCurrentWorkspaceRootPath.fire(currentWorkspaceRootPath)
      this.reviews.init(currentWorkspaceRootPath)
    }
    if (currentActiveFilePath && currentActiveFilePath !== this._currentActiveFilePath) {
      this._currentActiveFilePath = currentActiveFilePath
      updateNeeded = true
    }

    if (updateNeeded)
      await this.update({})
  }

  static async update({
    event,
    workspaceRootPathChanged,
    activeFilePathChanged
  }: {
    event?: ConfigurationChangeEvent
    workspaceRootPathChanged?: boolean
    activeFilePathChanged?: boolean
  } = {},
  ) {
    this.resetCache()

    let reload = false
    if (event) {
      let affected = false

      for (const config of Config.reloadConfigs) {
        const key = `${EXT_NAMESPACE}.${config}`
        if (event.affectsConfiguration(key)) {
          affected = true
          reload = true
          Log.info(`🧰 Config "${key}" changed, reloading`)
          break
        }
      }

      for (const config of Config.refreshConfigs) {
        const key = `${EXT_NAMESPACE}.${config}`
        if (event.affectsConfiguration(key)) {
          affected = true
          Log.info(`🧰 Config "${key}" changed`)
          break
        }
      }

      for (const config of Config.usageRefreshConfigs) {
        const key = `${EXT_NAMESPACE}.${config}`
        if (event.affectsConfiguration(key)) {
          Analyst.refresh()

          Log.info(`🧰 Config "${key}" changed`)
          break
        }
      }

      if (!affected)
        return

      if (reload)
        Log.info('🔁 Reloading loader')
    }

    if (!Config.enabledFrameworks) {
      [this.enabledFrameworks, this._nearestEnabledFrameworkPath] = this.findNearestEnabledFrameworks(
        this._currentWorkspaceRootPath,
        this._currentActiveFilePath,
      )
    }
    else {
      const frameworks = Config.enabledFrameworks
      this.enabledFrameworks = getEnabledFrameworksByIds(frameworks, this._currentWorkspaceRootPath)
    }
    const isValidProject = this.enabledFrameworks.length > 0 && this.enabledParsers.length > 0
    const hasLocalesSet = !!Global.localesPaths
    const shouldEnabled = !Config.disabled && isValidProject && hasLocalesSet
    this.setEnabled(shouldEnabled)

    if (this.enabled) {
      Log.info(`🧩 Enabled frameworks: ${this.enabledFrameworks.map(i => i.display).join(', ')}`)
      Log.info(`🧬 Enabled parsers: ${this.enabledParsers.map(i => i.id).join(', ')}`)
      Log.info('')
      commands.executeCommand('setContext', 'i18n-ally.extract.autoDetect', Config.extractAutoDetect)

      Telemetry.track(TelemetryKey.Enabled)
      Telemetry.updateUserProperties()

      await this.initLoader(this._currentWorkspaceRootPath, reload)
    }
    else {
      if (!Config.disabled) {
        if (!isValidProject && hasLocalesSet)
          Log.info('⚠ Current workspace is not a valid project, extension disabled')

        if (isValidProject && !hasLocalesSet && Config.autoDetection)
          ConfigLocalesGuide.autoSet()
      }

      this.unloadAll()
    }

    this._onDidChangeLoader.fire(this.loader)
  }

  private static findNearestEnabledFrameworks(root: string, current: string): [Framework[], string | undefined] {
    if (!current.startsWith(root))
      return [[], undefined]

    const subfolders = path.relative(root, current).split(path.sep)
    const folders: string[] = []

    for (let i = subfolders.length; i > 0; i--)
      folders.push(path.join(root, ...subfolders.slice(0, i)))
    folders.push(root)

    for (const folder of folders) {
      const packages = getPackageDependencies(folder)
      const frameworks = getEnabledFrameworks(packages, folder)
      if (frameworks.length)
        return [frameworks, folder]
    }
    return [[], undefined]
  }

  private static unloadAll() {
    Object.values(this._loaders).forEach(loader => loader.dispose())
    this._loaders = {}
  }

  static get loader() {
    return this._loaders[this._currentWorkspaceRootPath]
  }

  static get enabledParsers() {
    let ids = Config.enabledParsers?.length
      ? Config.enabledParsers
      : this.enabledFrameworks
        .flatMap(f => f.enabledParsers || [])

    if (!ids.length)
      ids = DefaultEnabledParsers

    return AvailableParsers.filter(i => ids.includes(i.id))
  }

  static getMatchedParser(ext: string) {
    if (!ext.startsWith('.') && ext.includes('.'))
      ext = extname(ext)

    // resolve custom parser extensions
    const id = Config.parsersExtendFileExtensions[ext.slice(1)]
    if (id)
      return this.enabledParsers.find(parser => parser.id === id)

    // resolve parser
    return this.enabledParsers.find(parser => parser.supports(ext))
  }

  // enables
  static get enabled() {
    return this._enabled
  }

  private static setEnabled(value: boolean) {
    if (this._enabled !== value) {
      Log.info(value ? '🌞 Enabled' : '🌚 Disabled')
      this._enabled = value
      commands.executeCommand('setContext', `${EXT_NAMESPACE}-enabled`, value)
      this._onDidChangeEnabled.fire(this._enabled)
    }
  }

  static get allLocales() {
    return CurrentFile.loader.locales
  }

  static get visibleLocales() {
    return this.getVisibleLocales(this.allLocales)
  }

  static getVisibleLocales(locales: string[]) {
    const ignored = Config.ignoredLocales
    return locales.filter(locale => !ignored.includes(locale))
  }

  static getExtractionFrameworksByLang(languageId: string) {
    return this.enabledFrameworks.filter(i => i.supportAutoExtraction?.includes(languageId))
  }
}
