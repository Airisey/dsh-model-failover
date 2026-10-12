/**
 * 极简 JSON 落盘存储。
 *
 * 为什么不复用 dsh 的设置服务：队列顺序、每日隔离名单这些状态里既有用户
 * 手写的配置，也有插件自己写的运行时事实，混进 profile 的 cordis 配置只会
 * 让「重置当天隔离」变成一次配置热重载。这里按 dsh 生态惯例，把自己的状态
 * 放在 `$DSH_HOME/<插件名>/` 下的独立 JSON 文件里。
 *
 * 写入策略：内存即真相，落盘走 200ms 防抖 + 临时文件原子改名。进程被杀时
 * 最多丢 200ms 的写入（隔离名单丢一条只是多试一次模型，代价可接受）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** `$DSH_HOME`，回落 `~/.dsh`。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 插件的状态目录，`$DSH_HOME/<namespace>/`。 */
export function dataDir(namespace) {
  return join(dshHome(), namespace)
}

/**
 * 一个 JSON 文件映射成的对象。
 *
 * @template T
 */
export class JsonFile {
  /**
   * @param {string} file - 绝对路径。
   * @param {T} fallback - 文件不存在或损坏时使用的默认值。
   * @param {(raw: unknown) => T} normalize - 把读到的任意 JSON 收敛成 T。
   */
  constructor(file, fallback, normalize) {
    this.file = file
    this.normalize = normalize
    this.fallback = fallback
    this.value = this.#read()
    this.timer = undefined
    this.dirty = false
  }

  #read() {
    try {
      const text = readFileSync(this.file, 'utf8')
      return this.normalize(JSON.parse(text))
    } catch {
      // 文件不存在、被截断、或 JSON 语法坏了：全部当作「还没有状态」。
      // 隔离名单丢失的最坏后果是多试一次模型，比启动失败好得多。
      return this.normalize(undefined)
    }
  }

  get() {
    return this.value
  }

  /** 浅合并式更新，返回新值。 */
  update(patch) {
    this.value = this.normalize({ ...this.value, ...patch })
    this.dirty = true
    this.#schedule()
    return this.value
  }

  /** 整体替换，返回新值。 */
  replace(next) {
    this.value = this.normalize(next)
    this.dirty = true
    this.#schedule()
    return this.value
  }

  #schedule() {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, 200)
    // 落盘定时器不该把进程钉住不退出。
    this.timer.unref?.()
  }

  /** 立即写盘。 */
  flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.value, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      // 写盘失败不能把一次模型调用打断。
      console.warn(`[${'dsh-model-failover'}] 状态落盘失败 ${this.file}: ${String(error?.message ?? error)}`)
    }
  }

  dispose() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.flush()
  }
}

/** 删除一个状态文件（设置页的「恢复默认」用）。 */
export function removeFile(file) {
  try {
    unlinkSync(file)
  } catch {
    /* 本来就不存在 */
  }
}
