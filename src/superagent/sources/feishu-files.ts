/**
 * Feishu's half of the SourceFiles contract: the attachments a message names as lark-cli renders them, one of them
 * downloaded and read on this host, and the resource grammar ticket reads use. The kind imports this file, so it imports
 * only the configuration type back, never the kind itself.
 */
import type { Trigger } from '../core/index.js'
import type { Commands } from '../commands.js'
import { feishuAttachments, readAttachment } from './feishu-attachment.js'
import { feishuRead } from './feishu-read.js'
import { feishuRef } from './feishu-trigger.js'
import type { SourceFiles } from './kind.js'
import type { FeishuConfig } from './feishu.js'

/** The Feishu reference of `trigger`; a trigger of another kind reaching here is a routing bug, so it throws. */
function refOf(trigger: Trigger) {
  const ref = feishuRef(trigger)
  if (!ref) throw new Error('A Feishu source trigger is required')
  return ref
}

export const feishuFiles: SourceFiles<FeishuConfig> = {
  prefix: 'feishu',
  attachments: trigger => feishuAttachments(trigger.text),
  read: (commands: Commands, trigger, ref) => readAttachment(commands, refOf(trigger).messageId, ref),
  readResource: (commands: Commands, trigger, resource, config) => feishuRead(commands, refOf(trigger), resource, config.readPageSize),
}
