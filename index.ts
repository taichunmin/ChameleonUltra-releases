import _ from 'lodash'
import { Buffer } from '@taichunmin/buffer'
import { Octokit } from '@octokit/core'
import { URL } from 'url'
import axios from 'axios'
import fsPromises from 'fs/promises'
import JSZip from 'jszip'
import path from 'path'

const BASEURL = getenv('BASEURL', 'https://taichunmin.idv.tw/ChameleonUltra-releases/')
const ASSET_NAME_WHITELIST = [
  'chameleon_lite_app_update.zip',
  'chameleon_ultra_app_update.zip',
  'lite-dfu-app.zip',
  'lite-dfu-full.zip',
  'ultra-dfu-app.zip',
  'ultra-dfu-full.zip',
]

function getenv (key: string, defaultVal: any): string {
  return process.env?.[key] ?? defaultVal
}

async function sleep (t: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, t))
}

async function main (): Promise<void> {
  try {
    const octokit = new Octokit()
    const manifest: any = { releases: [], lastModifiedAt: new Date().toISOString() }
    const releases = (await octokit.request('GET /repos/{owner}/{repo}/releases', {
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
      owner: 'RfidResearchGroup',
      repo: 'ChameleonUltra',
    }))?.data
    // await writeFile('dist/releases.json', JSON.stringify(releases, null, 2))
    for (const release of releases) {
      const manifestRelease: any = { 
        assets: [],
        commit: release.target_commitish,
        createdAt: new Date(release.created_at).toISOString(),
        prerelease: release.prerelease,
        tagName: release.tag_name,
      }
      manifest.releases.push(manifestRelease)
      for (const asset of release.assets) {
        if (_.includes(ASSET_NAME_WHITELIST, asset.name) === false) continue
        const assetFile = await axios.get(asset.browser_download_url, { responseType: 'arraybuffer' })
        const assetBuf = Buffer.fromView(assetFile.data)
        const assetPath = `${release.tag_name}/${asset.name}`
        await writeFile(`dist/${assetPath}`, assetBuf)
        const assetUrl = new URL(assetPath, BASEURL)
        manifestRelease.assets.push({ 
          name: asset.name,
          size: asset.size,
          url: assetUrl,
        })
        console.log(`Downloaded ${assetUrl}`)

        // get gitVersion from ultra-dfu-app.zip
        if (asset.name === 'ultra-dfu-app.zip') {
          const dfuZip = new DfuZip(assetBuf)
          const appImage = await dfuZip.getAppImage()
          if (_.isNil(appImage)) throw new Error('Failed to get app image from ultra-dfu-app.zip')
          const gitVersion = await dfuZip.getGitVersion()
          if (!_.isNil(gitVersion)) manifestRelease.gitVersion = gitVersion
        }
      }
    }
    await writeFile(`dist/manifest.json`, JSON.stringify(manifest))
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

async function writeFile (filepath, data): Promise<void> {
  const dist = path.resolve(__dirname, filepath)
  await fsPromises.mkdir(path.dirname(dist), { recursive: true })
  await fsPromises.writeFile(dist, data)
}

main().catch(err => { console.error(err) })

class DfuZip {
  readonly #buf: Buffer
  #zip: JSZip | null = null
  #manifest: DfuManifest | null = null

  constructor (buf: Buffer) {
    this.#buf = buf
  }

  async getManifest (): Promise<DfuManifest> {
    if (_.isNil(this.#zip)) this.#zip = await JSZip.loadAsync(this.#buf)
    if (_.isNil(this.#manifest)) {
      const manifestJson = await this.#zip.file('manifest.json')?.async('string')
      if (_.isNil(manifestJson)) throw new Error('Unable to find manifest, is this a proper DFU package?')
      this.#manifest = JSON.parse(manifestJson).manifest
    }
    return this.#manifest as DfuManifest
  }

  async getImage (types: DfuImageType[]): Promise<DfuImage | null> {
    const manifest = await this.getManifest()
    for (const type of types) {
      const image = manifest[type]
      if (_.isNil(image)) continue
      const [header, body] = await Promise.all(_.map([image.dat_file, image.bin_file], async file => {
        const u8 = await this.#zip?.file(file)?.async('uint8array')
        if (_.isNil(u8)) throw new Error(`Failed to read ${file} from DFU package`)
        return Buffer.fromView(u8)
      }))
      return { type, header, body }
    }
    return null
  }

  async getBaseImage (): Promise<DfuImage | null> {
    return await this.getImage(['softdevice', 'bootloader', 'softdevice_bootloader'])
  }

  async getAppImage (): Promise<DfuImage | null> {
    return await this.getImage(['application'])
  }

  async getGitVersion (): Promise<string | null> {
    const image = await this.getAppImage()
    if (_.isNil(image)) return null
    // eslint-disable-next-line no-control-regex
    return image.body.toString('utf8').match(/\x00(v\d+(?:\.\d+)*[\w-]*)\x00/)?.[1] ?? null
  }
}

type DfuManifest = Record<DfuImageType, { bin_file: string, dat_file: string }>
type DfuImageType = 'application' | 'softdevice' | 'bootloader' | 'softdevice_bootloader'

interface DfuImage {
  type: DfuImageType
  header: Buffer
  body: Buffer
}