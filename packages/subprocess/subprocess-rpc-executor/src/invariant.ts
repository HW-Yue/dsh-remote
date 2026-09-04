/** Package-owned invariant companion for the local RPC executor. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-subprocess-rpc-executor'

/** Cordis companion plugin name. */
export const name = 'subprocess-rpc-executor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']
/** No runtime invariant: executor ownership is scoped to its server connection. */
const install: InvariantInstaller = () => {}
/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
