/** WeCom source kind: replies back into the conversation a Session is bound to, through the dsh-im host service. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type ChannelRef, type OutboundMessage } from '../core/index.ts'
import { SourcePolicySchema } from '../policy.ts'
import type { ChannelLink, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export const SOURCE = 'wecom'
/**
 * The conversation a DSH Session is bound to, as dsh-im reports it from its own channel state; `chatType` separates a group
 * chat from a person's chat because WeCom routes both by the same `chatId`.
 */
export interface ImConversation {
  channel: string
  botId: string
  botName: string | null
  conversationKey: string
  chatType: 'group' | 'user' | null
  chatId: string | null
  threadId: string | null
  chatTitle: string | null
  senderId: string | null
  senderName: string | null
  senderUsername?: string | null
  senderIsBot?: boolean | null
}
/**
 * The part of dsh-im's host service (`ctx.dshIm`) this Source and `orchestrator_open` call, described structurally so building
 * dsh-superagent needs neither the package nor its types.
 */
export interface DshIm {
  /** Delivers text to one conversation of a bot; rejects with a dsh-im `error.code` such as `target-rejected` or `delivery-failed`. */
  send(botId: string, target: string | { kind: 'user' | 'group'; route: { chatId: string } }, text: string,
    options?: { signal?: AbortSignal }): Promise<{ sent: true }>
  /** The conversation a Session is bound to, read from dsh-im's state; `null` when the Session has none. */
  describeConversation(sessionId: string): Promise<ImConversation | null>
  describeConversationSync(sessionId: string): ImConversation | null
}
declare module '@deepseek-ai/cordis' { interface Context { dshIm?: DshIm } }
/**
 * The project one WeCom group's tickets belong to: the directory of a git repository the worker edits, and the branch its
 * worktree starts from (empty means the repository's current branch, which is what a checkout already has).
 */
const WecomProjectSchema = z.object({ chat: z.string().trim().min(1), dir: z.string().trim().regex(/^(?:[A-Za-z]:[\\/]|\/)/),
  branch: z.string().trim().default('') }).strict()
export type WecomProject = z.infer<typeof WecomProjectSchema>
/**
 * The dsh-im bot id this Source replies as; empty means whichever bot the conversation is bound to. `projects` maps a group
 * chat to the project its tickets work in, because a worktree needs a repository to branch from.
 */
const WecomConfigSchema = z.object({ bot: z.string().trim().max(128).default(''),
  projects: z.array(WecomProjectSchema).default([]) }).strict()
export type WecomConfig = z.infer<typeof WecomConfigSchema>
/** WeCom has no per-message link, so a channel link names the channel and carries no URL. */
export const wecomLink = (): ChannelLink => ({ url: '', label: { zh: '企业微信', en: 'WeCom' } })
/** Reply address of a conversation; `kind` tells dsh-im which WeCom send path to use, and `chat` keeps the chat readable in meta. */
export function wecomChannel(conversation: ImConversation, chatId: string): ChannelRef {
  return { source: SOURCE, thread: `${SOURCE}:${chatId}`,
    address: { bot: conversation.botId, target: chatId, chat: chatId, kind: conversation.chatType === 'user' ? 'user' : 'group' } }
}
/** How long the same command from the same person counts as the same request rather than a new one. */
export const SAME_REQUEST_MS = 5 * 60_000
/**
 * Trigger ID of one `/bug` or `/need` command. A tool call the model repeats inside the same window is the Engine's duplicate
 * instead of a second ticket; a person who sends the same text again after that window asks again, and gets a new ticket.
 */
export const wecomTriggerId = (chatId: string, senderId: string, command: string, text: string, at: number = Date.now()): string =>
  key('wecom', 'open', chatId, senderId, command, text, String(Math.floor(at / SAME_REQUEST_MS)))
/**
 * The project a chat's tickets work in, or undefined when the chat has no row. A chatId that dsh-im did not record (or a
 * Trigger from another Source) matches nothing rather than the first row, so an unbound group never borrows another one.
 */
export const wecomProject = (config: WecomConfig, chatId: string | null | undefined): WecomProject | undefined =>
  (chatId ? config.projects.find(project => project.chat === chatId) : undefined)
/** dsh-im codes meaning WeCom refused this conversation for good: the bot left it, lost permission, or never had it. */
const GONE: ReadonlySet<string> = new Set(['unknown-bot', 'unknown-target', 'target-rejected', 'invalid-target'])
const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
/**
 * Posts a reply through dsh-im. dsh-im keeps no delivery history and offers no idempotency key, so a retry after an unclear
 * failure posts again; a conversation WeCom no longer accepts answers `'gone'` and the reply is dropped instead of retried.
 */
async function sendWecom(im: DshIm, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { bot, target, kind } = message.channel.address
  if (!bot || !target) return 'gone'
  try {
    await im.send(bot, { kind: kind === 'user' ? 'user' : 'group', route: { chatId: target } }, message.text)
    return 'sent'
  } catch (error) {
    const code = codeOf(error)
    if (code && GONE.has(code)) return 'gone'
    throw error
  }
}
/**
 * WeCom source kind. dsh-im forwards a group message only when it mentions the bot and keeps every inbound message to itself,
 * so this kind has no polling loop and no inbound reader: it delivers replies, and a `/bug` or `/need` message reaches the
 * main Session directly, which opens a ticket with `orchestrator_open`. Assessments of a WeCom Trigger read no context.
 */
export function wecomKind(im: DshIm): SourceKind<WecomConfig> {
  return {
    kind: SOURCE,
    title: { zh: '企业微信', en: 'WeCom' },
    description: { zh: '通过 dsh-im 把工单的回复发回发起它的企业微信会话；不读取群消息。', en: 'Sends ticket replies back to the WeCom conversation a ticket came from, through dsh-im; it reads no chat messages.' },
    schema: WecomConfigSchema,
    fields: [
      { key: 'bot', type: 'text', label: { zh: '回复的机器人', en: 'Reply bot' },
        hint: { zh: 'dsh-im 里的机器人 ID；留空时用会话绑定的机器人。设置后，其他机器人的会话不会被回复。', en: 'A dsh-im bot ID; empty uses the bot the conversation is bound to. When set, conversations of another bot are not replied to.' } },
      { key: 'projects', type: 'rows', label: { zh: '群与项目', en: 'Chats and projects' },
        hint: { zh: '每行把一个企业微信群的 chatId 对应到一个本机 git 仓库；在这个群里开单的工单在该仓库的 worktree 里干活，提交在 dsh/<工单名> 分支上。基线分支留空时用仓库当前分支。', en: 'Each row maps a WeCom group chatId to a local git repository; a ticket opened in that group works in a worktree of the repository and commits on branch dsh/<ticket name>. An empty base branch uses the repository\'s current branch.' },
        columns: [{ key: 'chat', type: 'text', label: { zh: '群 chatId', en: 'Chat ID' } },
          { key: 'dir', type: 'text', label: { zh: '项目目录', en: 'Project directory' } },
          { key: 'branch', type: 'text', label: { zh: '基线分支', en: 'Base branch' }, optional: true }] },
    ],
    health: [],
    // Every message that reaches this kind is addressed to the bot, and the chat must be bound to a project before a ticket
    // opens, so the admission row lives under one name and its cells decide who may open one.
    scope: () => ({ listened: true, observed: false, row: 'wecom' }),
    // The directory reaches the Executor as a variable, so its prompt names the repository the worktree comes from.
    environment: {
      variables: [
        { key: 'DSH_SUPERAGENT_PROJECT_DIR', description: { zh: '这个工单所属项目的目录（一个 git 仓库）', en: 'Directory of the project this ticket belongs to (a git repository)' } },
        { key: 'DSH_SUPERAGENT_PROJECT_BRANCH', description: { zh: 'worktree 的基线分支；为空时用仓库当前分支', en: 'Base branch the worktree starts from; empty means the repository\'s current branch' } },
      ],
      values: ({ config, trigger }): Record<string, string> => {
        // The directory a ticket was opened with stays its own, so editing the table later does not move work already started.
        const opened = trigger?.source === SOURCE && typeof trigger.meta.project === 'string' ? trigger.meta.project : ''
        const bound = wecomProject(config, trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : undefined)
        const project = opened || bound?.dir
        // A measured base branch rides with the ticket as well; both come from the row the ticket was opened with.
        const branch = trigger?.source === SOURCE && typeof trigger.meta.branch === 'string' ? trigger.meta.branch : bound?.branch ?? ''
        return { ...project ? { DSH_SUPERAGENT_PROJECT_DIR: project } : {}, ...branch ? { DSH_SUPERAGENT_PROJECT_BRANCH: branch } : {} }
      },
    },
    channel: {
      allowed: (address, config) => !!address.bot && !!address.target && (!config.bot || config.bot === address.bot),
      send: (_host, message) => sendWecom(im, message),
      link: wecomLink,
    },
    // The panel draws the allow list from a policy part; without one a Source has no admission UI at all.
    policy: {
      unnamed: { person: { zh: '企业微信用户', en: 'WeCom user' }, bot: { zh: '企业微信机器人', en: 'WeCom bot' } },
      schema: SourcePolicySchema.extend({
        allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
          .refine(people => new Set(people.map(person => person.id)).size === people.length, 'Duplicate user ids').default([]),
      }),
      // The kind marks every bot-directed message as addressed and stores one admission row for the whole Source, so the
      // operator can let every user of a bound chat open a ticket without naming each one first.
      rows: () => [{ id: 'wecom', label: { zh: '企业微信消息', en: 'WeCom messages' }, note: { zh: '仅 @机器人', en: '@-mentions only' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }],
      fields: [
        { key: 'allowed', type: 'rows', label: { zh: '能开单的企业微信用户', en: 'WeCom users who may open tickets' },
          hint: { zh: '名单内的人在群里 @ 机器人并发送 /bug 或 /need 时开单；其他人的消息被忽略。', en: 'Someone on the list opens a ticket by mentioning the bot in a group and sending /bug or /need; messages from anyone else are ignored.' },
          columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' } },
            { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      ],
      explicit: { zh: '名单内的人 @ 机器人后发送 /bug 或 /need，是明确的请求。', en: 'A person on the list who mentions the bot and sends /bug or /need makes an explicit request.' },
    },
  }
}

/** Returns the WeCom Source's settings, falling back to schema defaults while the Source is off or not installed. */
export const wecomSettings = (sources: SourceRegistry): WecomConfig =>
  sources.instance<WecomConfig>(SOURCE)?.config ?? WecomConfigSchema.parse({})

export const name = 'dsh-superagent-wecom'
export const inject = ['orchestrator', 'dshIm']
/** Registers the kind; dsh-im owns reception, so there is no loop or timer to start. */
export function apply(ctx: Context): void {
  const im = ctx.dshIm
  if (!im) return
  ctx.effect(() => ctx.orchestrator.sources.register(wecomKind(im)), 'wecom: source kind')
}
