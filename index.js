const os = require('os')
const fs = require('fs')
const path = require('path')
const core = require('@actions/core')
const exec = require('@actions/exec')
const common = require('./common')

const ENV = process.env

const inputDefaults = {
  'ruby-version': 'default',
  'bundler': 'default',
  'working-directory': '.',
}

export async function run() {
  try {
    const options = {}
    for (const key in inputDefaults) {
      options[key] = core.getInput(key)
    }
    await setupRuby(options)
  } catch (error) {
    core.setFailed(error.message)
  }
}

export async function setupRuby(options) {
  const inputs = { ...inputDefaults, ...options }

  process.chdir(inputs['working-directory'])

  const platform = common.getVirtualEnvironmentName()
  const [engine, parsedVersion] = parseRubyEngineAndVersion(inputs['ruby-version'])

  let installer
  if (platform === 'windows-latest' && engine !== 'jruby') {
    installer = require('./windows')
  } else {
    installer = require('./ruby-builder')
  }

  const engineVersions = installer.getAvailableVersions(platform, engine)
  const version = validateRubyEngineAndVersion(platform, engineVersions, engine, parsedVersion)

  createGemRC()

  envPreInstall()

  const [rubyPrefix, newPathEntries] = await installer.install(platform, engine, version)

  envPostInstall(newPathEntries)

  if (inputs['bundler'] !== 'none') {
    await common.measure('Installing Bundler', async () =>
      installBundler(inputs['bundler'], platform, rubyPrefix, engine, version))
  }

  core.setOutput('ruby-prefix', rubyPrefix)
}

function parseRubyEngineAndVersion(rubyVersion) {
  if (rubyVersion === 'default') {
    if (fs.existsSync('.ruby-version')) {
      rubyVersion = '.ruby-version'
    } else if (fs.existsSync('.tool-versions')) {
      rubyVersion = '.tool-versions'
    } else {
      throw new Error('input ruby-version needs to be specified if no .ruby-version or .tool-versions file exists')
    }
  }

  if (rubyVersion === '.ruby-version') { // Read from .ruby-version
    rubyVersion = fs.readFileSync('.ruby-version', 'utf8').trim()
    console.log(`Using ${rubyVersion} as input from file .ruby-version`)
  } else if (rubyVersion === '.tool-versions') { // Read from .tool-versions
    const toolVersions = fs.readFileSync('.tool-versions', 'utf8').trim()
    const rubyLine = toolVersions.split(/\r?\n/).filter(e => e.match(/^ruby\s/))[0]
    rubyVersion = rubyLine.split(/\s+/, 2)[1]
    console.log(`Using ${rubyVersion} as input from file .tool-versions`)
  }

  let engine, version
  if (rubyVersion.match(/^(\d+)/) || common.isHeadVersion(rubyVersion)) { // X.Y.Z => ruby-X.Y.Z
    engine = 'ruby'
    version = rubyVersion
  } else if (!rubyVersion.includes('-')) { // myruby -> myruby-stableVersion
    engine = rubyVersion
    version = '' // Let the logic below find the version
  } else { // engine-X.Y.Z
    [engine, version] = rubyVersion.split('-', 2)
  }

  return [engine, version]
}

function validateRubyEngineAndVersion(platform, engineVersions, engine, parsedVersion) {
  if (!engineVersions) {
    throw new Error(`Unknown engine ${engine} on ${platform}`)
  }

  let version = parsedVersion
  if (!engineVersions.includes(parsedVersion)) {
    const latestToFirstVersion = engineVersions.slice().reverse()
    const found = latestToFirstVersion.find(v => !common.isHeadVersion(v) && v.startsWith(parsedVersion))
    if (found) {
      version = found
    } else {
      throw new Error(`Unknown version ${parsedVersion} for ${engine} on ${platform}
        available versions for ${engine} on ${platform}: ${engineVersions.join(', ')}
        File an issue at https://github.com/ruby/setup-ruby/issues if would like support for a new version`)
    }
  }

  return version
}

function createGemRC() {
  const gemrc = path.join(os.homedir(), '.gemrc')
  if (!fs.existsSync(gemrc)) {
    fs.writeFileSync(gemrc, `gem: --no-document${os.EOL}`)
  }
}

// sets up ENV for Ruby installation
function envPreInstall() {
  if (os.platform() === 'win32') {
    // puts normal Ruby temp folder on SSD
    common.cmd.addVari('TMPDIR', ENV['RUNNER_TEMP'])
    // bash - sets home to match native windows, normally C:\Users\<user name>
    common.cmd.addVari('HOME', ENV['HOMEDRIVE'] + ENV['HOMEPATH'])
    // bash - needed to maintain Path from Windows
    common.cmd.addVari('MSYS2_PATH_TYPE', 'inherit')
    // add MSYS2 for bash shell and RubyInstaller2 devkit
    common.cmd.addPath(`C:\\msys64\\mingw64\\bin;C:\\msys64\\usr\\bin`)
  }
}

// remove system Rubies if in PATH
function cleanPath() {
  const os_path = (os.platform() === 'win32') ? 'Path' : 'PATH'
  const origPath = ENV[os_path].split(path.delimiter)

  let noRubyPath = origPath.filter(entry => !/\bruby\b/i.test(entry))

  if (origPath.length !== noRubyPath.length) {
    core.startGroup('Cleaning PATH')
    console.log('Entries removed from PATH to avoid conflicts with Ruby:')
    for (const entry of origPath) {
      if (!noRubyPath.includes(entry)) {
        console.log(`  ${entry}`)
      }
    }
    core.endGroup()
    ENV[os_path] = noRubyPath.join(path.delimiter)
  }
}

// adds ENV items and pushed to runner via common.cmd
function envPostInstall(newPathEntries) {
  cleanPath()
  common.cmd.addPath(`${newPathEntries.join(path.delimiter)}`)
  common.cmd.sendAll()
}

function readBundledWithFromGemfileLock() {
  if (fs.existsSync('Gemfile.lock')) {
    const contents = fs.readFileSync('Gemfile.lock', 'utf8')
    const lines = contents.split(/\r?\n/)
    const bundledWithLine = lines.findIndex(line => /^BUNDLED WITH$/.test(line.trim()))
    if (bundledWithLine !== -1) {
      const nextLine = lines[bundledWithLine+1]
      if (nextLine && /^\d+/.test(nextLine.trim())) {
        const bundlerVersion = nextLine.trim()
        const majorVersion = bundlerVersion.match(/^\d+/)[0]
        console.log(`Using Bundler ${majorVersion} from Gemfile.lock BUNDLED WITH ${bundlerVersion}`)
        return majorVersion
      }
    }
  }
  return null
}

async function installBundler(bundlerVersionInput, platform, rubyPrefix, engine, rubyVersion) {
  var bundlerVersion = bundlerVersionInput

  if (bundlerVersion === 'default' || bundlerVersion === 'Gemfile.lock') {
    bundlerVersion = readBundledWithFromGemfileLock()
    if (!bundlerVersion) {
      bundlerVersion = 'latest'
    }
  }

  if (bundlerVersion === 'latest') {
    bundlerVersion = '2'
  }

  if (/^\d+/.test(bundlerVersion)) {
    // OK
  } else {
    throw new Error(`Cannot parse bundler input: ${bundlerVersion}`)
  }

  if (rubyVersion.startsWith('2.2')) {
    console.log('Bundler 2 requires Ruby 2.3+, using Bundler 1 on Ruby 2.2')
    bundlerVersion = '1'
  } else if (rubyVersion.startsWith('2.3')) {
    console.log('Ruby 2.3 has a bug with Bundler 2 (https://github.com/rubygems/rubygems/issues/3570), using Bundler 1 instead on Ruby 2.3')
    bundlerVersion = '1'
  }

  if (engine === 'ruby' && common.isHeadVersion(rubyVersion) && bundlerVersion === '2') {
    console.log(`Using Bundler 2 shipped with ${engine}-${rubyVersion}`)
  } else if (engine === 'truffleruby' && bundlerVersion === '1') {
    console.log(`Using Bundler 1 shipped with ${engine}`)
  } else if (engine === 'rubinius') {
    console.log(`Rubinius only supports the version of Bundler shipped with it`)
  } else {
    const gem = path.join(rubyPrefix, 'bin', 'gem')
    await exec.exec(gem, ['install', 'bundler', '-v', `~> ${bundlerVersion}`, '--no-document'])
  }
}

if (__filename.endsWith('index.js')) { run() }
