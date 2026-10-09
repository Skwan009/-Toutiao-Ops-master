/**
 * 运行时目录统一入口。
 *
 * 所有运行时产物（核验快照、推荐结果、外部热点缓存）一律写 `~/.toutiao-ops/`，
 * 不写包内：全局安装后 `node_modules` 通常只读，写入会静默失败。
 */
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

/** 运行时根目录 */
export const BASE_DIR = join(homedir(), '.toutiao-ops');

/**
 * 取运行时子目录，并确保其存在。
 * @param {...string} parts 子路径片段，如 runtimeDir('verify')
 * @returns {string} 绝对路径
 */
export function runtimeDir(...parts) {
  const dir = join(BASE_DIR, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
