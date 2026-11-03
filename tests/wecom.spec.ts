/** WeCom project binding: the group a `/bug` came from decides which repository the ticket's worktree comes from. */
import { describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { wecomKind, wecomProject, type DshIm, type WecomConfig } from '../src/sources/wecom.ts'
import { testDeployment } from './fixtures/deployment.ts'

const KIND = wecomKind({} as DshIm)
const CONFIG: WecomConfig = KIND.schema.parse({ projects: [{ chat: 'wr_team', dir: 'D:\\work\\repo', branch: 'main' },
  { chat: 'wr_other', dir: '/srv/other' }] })
const trigger = (meta: Record<string, unknown>, source = 'wecom'): Trigger => ({ id: 'wecom:open:x', source, threads: [],
  actor: { source, id: 'zhang' }, human: true, addressed: 'direct', at: '2026-11-03T00:00:00.000Z', text: '/bug 崩溃了', meta }) as Trigger
const values = (meta: Record<string, unknown>, source?: string) =>
  KIND.environment!.values({ deployment: testDeployment(), config: CONFIG, trigger: trigger(meta, source) })

describe('wecom project binding', () => {
  it('finds the row of a chat and nothing for another chat', () => {
    expect(wecomProject(CONFIG, 'wr_team')?.dir).toBe('D:\\work\\repo')
    expect(wecomProject(CONFIG, 'wr_stranger')).toBeUndefined()
    expect(wecomProject(CONFIG, null)).toBeUndefined()
  })
  it('gives the Executor the bound directory and base branch, and no variable for an unbound chat or another source', () => {
    expect(values({ chatId: 'wr_team' })).toEqual({ DSH_SUPERAGENT_PROJECT_DIR: 'D:\\work\\repo', DSH_SUPERAGENT_PROJECT_BRANCH: 'main' })
    expect(values({ chatId: 'wr_other' })).toEqual({ DSH_SUPERAGENT_PROJECT_DIR: '/srv/other' })
    expect(values({ chatId: 'wr_stranger' })).toEqual({})
    expect(values({ chatId: 'wr_team' }, 'feishu')).toEqual({})
  })
  it('keeps the directory and branch the ticket opened with when the table changes later', () => {
    expect(values({ chatId: 'wr_team', project: '/srv/moved', branch: 'release' })).toEqual({ DSH_SUPERAGENT_PROJECT_DIR: '/srv/moved',
      DSH_SUPERAGENT_PROJECT_BRANCH: 'release' })
    // A row edited after the ticket opened still supplies the branch the worktree predates.
    expect(values({ chatId: 'wr_team', project: '/srv/moved' })).toEqual({ DSH_SUPERAGENT_PROJECT_DIR: '/srv/moved',
      DSH_SUPERAGENT_PROJECT_BRANCH: 'main' })
  })
})
