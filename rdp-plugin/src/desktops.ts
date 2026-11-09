import { desktopPolicy, desktopObservation, fieldsObservation, scalarObservation } from './desktopPolicy'
import { identity } from './identity'
import { signInName } from './accounts'
import { ClipboardMode } from './clipboard'
import { RemoteTarget } from './targets'
import { WakeSpec } from './wake'

/**
 * What kind of RDP server a desktop is. 'gnome': the SSH host's own desktop, set up automatically (headless
 * GNOME Remote Desktop, generated credentials). 'windows': a Windows machine the SSH host can reach (e.g. a
 * VM with its RDP port forwarded to the host's loopback), or the SSH host itself when it runs Windows; signs in
 * with the Windows account. 'xrdp': a Linux desktop other than GNOME (KDE, XFCE, MATE, …) served by xrdp; signs in
 * with the Linux account.
 */
export type DesktopKind = 'gnome' | 'windows' | 'xrdp'

/**
 * What the remote setup found on an SSH host (see remoteSetup.ts): which desktop is its own (GNOME, xrdp, or Windows'
 * RDP server when the host runs Windows), and xrdp's port and the account to suggest when xrdp runs there.
 */
export interface OwnDesktopFound {
    kind: 'gnome' | 'xrdp' | 'windows'
    xrdpPort?: number
    xrdpUser?: string
}

/** A desktop reachable through an SSH connection. */
export interface DesktopSpec {
    /** 'own' for the SSH host's own desktop, otherwise `host:port`. */
    id: string
    /** For menus and status messages. */
    name: string
    kind: DesktopKind
    /** Where the RDP server is, as seen from the SSH host (unused for GNOME's own desktop: the setup reports the port). */
    host: string
    port: number
    username?: string
    domain?: string
    /** A saved account's id (see accounts.ts): signs in with it, in place of `username` and `domain`. */
    account?: string
    /** How to start it when it doesn't answer (a VM on the SSH host, or Wake-on-LAN). */
    wake?: WakeSpec
    /** A VM found on the SSH host (see vms.ts), not configured: whether it was running or off when found. */
    found?: 'running' | 'off'
    /**
     * A Hyper-V VM's id: its console, reached through its host (the SSH host, port 2179; see hyperv.ts) rather than a
     * desktop with an address of its own. The sign-in is the host's.
     */
    hyperv?: string
    /**
     * An RD Gateway's address (`host` or `host:port`, see gateway.ts) to reach the desktop through: `host` is then as
     * the gateway sees it, and the gateway as the SSH host (or this computer, for a direct desktop) sees it.
     */
    gateway?: string
    /** A saved account's id to sign in to the gateway with; without it, the desktop's own sign-in is the gateway's too. */
    gatewayAccount?: string
    /**
     * The kind is the user's word: a configured desktop or an RDP profile, of the kind the user gave it (not a VM saved
     * from a host's list as the host reported it, see xrdpFromHost). Only then does an xrdp desktop sign in without
     * Network Level Authentication unasked (see xrdpUnasked). What a host reports is its word: about the VMs it finds,
     * the machines reached through it with ssh, and its own desktop too, whose kind its setup reports. A host could
     * otherwise call any server it offers xrdp, its own included, and have the password sent to it as it is; and a host
     * the user signs in to with an SSH key need not have that password.
     */
    kindTrusted?: boolean
    /** The ways the clipboard goes with this desktop, in place of the setting's (see clipboard.ts). */
    clipboard?: ClipboardMode
}

/**
 * An entry of `remoteDesktop.desktops` in Tabby's config: another desktop behind an SSH host.
 *
 *     remoteDesktop:
 *       desktops:
 *         - name: Windows VM
 *           via: myhost            # SSH host alias, hostname, user@hostname or user@hostname:port
 *           host: 192.168.122.20   # as seen from that host
 *           port: 3389
 *           kind: windows          # or xrdp, or gnome
 *           username: alice
 *           account: k3f9x2ab      # or a saved account's id, in place of username and domain
 *           wake: { vm: win11 }    # optional: start it when it's off; or { mac: "aa:bb:cc:dd:ee:ff" }
 *         - name: Build VM
 *           via: hyperv-host       # a Windows SSH host running Hyper-V
 *           hyperv: 5f05e000-...   # the VM's id (Get-VM): its console through the host, started when it's off
 *         - name: Office PC
 *           via: myhost
 *           host: pc17.corp.example # as the gateway sees it
 *           gateway: rdgw.example.com   # an RD Gateway (port 443, or host:port), as seen from the SSH host
 *           gatewayAccount: k3f9x2ab    # optional: a saved account for the gateway, when not the desktop's sign-in
 *           clipboard: off              # optional: both, fromRemote or off, in place of the setting `clipboard`
 */
export interface ExtraDesktopConfig {
    name?: string
    via?: string
    host?: string
    port?: number
    /** 'windows' (also what null, an imported RDP profile's, and anything else is), 'xrdp' or 'gnome'. */
    kind?: string | null
    username?: string
    domain?: string
    /** A saved account's id; null (an imported RDP profile's options) is none, as are '' and its absence. */
    account?: string | null
    wake?: { vm?: string, mac?: string, broadcast?: string, port?: number, hyperv?: string }
    hyperv?: string
    gateway?: string
    /** A saved account's id or ASK_GATEWAY_ACCOUNT for a separate prompt; null, '' and absence use the desktop's. */
    gatewayAccount?: string | null
    /**
     * Saved from a VM the host found (see saveFoundDesktop): `kind` is what the host reported, not the user's choice
     * (true), until the user picks a kind in the form (false, where xrdpFromHost would otherwise take it for the
     * host's).
     */
    kindFromHost?: boolean
    clipboard?: string
}

export const OWN_DESKTOP = 'own'

/**
 * Whether a `via` value names this SSH target: its alias (label), hostname, user@hostname, or user@hostname:port, as ssh
 * resolved them (or the key itself). Never a machine reached with ssh typed in a host's console: its name, its user and
 * its hostname there are that host's word, which could name any host the user configured desktops behind (and with them
 * their saved accounts). Only its own desktop opens through that host.
 */
export function viaMatches (via: unknown, target: RemoteTarget): boolean {
    return identity('via_matches', configText(via), target.key, target.label, target.via !== undefined)
}

/**
 * A config value as text: a string as it is, a number written out. Anything else is none: String() of an object (a
 * hand edit, config sync) runs its own conversions, which can throw, and every desktop listed with it would fail, as
 * would every menu or list that shows it.
 */
export function configText (value: unknown): string {
    return desktopPolicy('config_text', scalarObservation(value))
}

/** The desktop an entry describes (a `remoteDesktop.desktops` entry, or an RDP profile's options), or null if unusable. */
export function specOf (extra: ExtraDesktopConfig): DesktopSpec | null {
    // Preserve the required entry observation; malformed null entries still fail here.
    void extra.host
    return desktopPolicy('spec', desktopObservation(extra))
}

/**
 * Whether an entry is of the xrdp kind on a host's word rather than the user's (see DesktopSpec.kindTrusted): a VM
 * saved from the host's list as the host reported it (`kindFromHost`). Up to 0.5.0 those were saved without the mark,
 * and one then looks like this: xrdp, started by its name when it is off (`wake.vm`, which the save always set). Such
 * an entry is taken for the host's word too, unless the user has picked its kind in the form since (`kindFromHost:
 * false`); a desktop of the user's that looks the same asks once before signing in without NLA.
 */
export function xrdpFromHost (extra: ExtraDesktopConfig): boolean {
    void extra.kind
    return desktopPolicy('xrdp_from_host', desktopObservation(extra))
}

/** A Hyper-V VM's console as a desktop of its host: the host's VMConnect port, the VM's id, started when it's off. */
export function hyperVSpec (id: string, name: string, more: Partial<DesktopSpec> = {}): DesktopSpec {
    return desktopPolicy('hyperv_spec', id, name, more)
}

/**
 * The SSH host's own desktop, then the configured desktops behind it, then `more` (RDP profiles going through this
 * host). `found`: what the setup found there the last time (none yet: GNOME, as the setup will try first). A host
 * with only xrdp has it as its own desktop; one with both GNOME and xrdp also offers xrdp, as a desktop at its
 * loopback port. A Windows host's own desktop is its RDP server, signed in to with the Windows account (the SSH user,
 * to start with). `clipboard`: the setting, which desktops without their own follow.
 */
export function desktopsFor (target: RemoteTarget, extras: ExtraDesktopConfig[] | undefined, found?: OwnDesktopFound, more: ExtraDesktopConfig[] = [], clipboard: ClipboardMode = 'both'): DesktopSpec[] {
    void target.label
    return desktopPolicy('desktops', fieldsObservation(target, ['key', 'label', 'via']), (Array.isArray(extras) ? extras : []).map(desktopObservation), fieldsObservation(found, ['kind', 'xrdpPort', 'xrdpUser']), more.map(extra => { void extra.host; return desktopObservation(extra) }), clipboard)
}

/** The target key of direct connections (remote desktop tabs); their session keys are `rdp#<address>`. */
export const DIRECT_KEY = 'rdp'

/**
 * The id of a configured desktop (`host:port`), as its DesktopSpec and session keys have it (see specOf), whatever the
 * entry holds: a host or port that is neither text nor a number makes an id that no desktop has, and nothing is kept
 * under it.
 */
export function desktopIdOf (extra: ExtraDesktopConfig): string {
    return desktopPolicy('desktop_id', desktopObservation(extra))
}

/** Whether an item of `remoteDesktop.desktops` is an entry (a map) at all: anything else describes no desktop. */
export function isDesktopEntry (value: unknown): value is ExtraDesktopConfig {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A configured desktop's entry as menus and lists show it: its name, else its address (see desktopIdOf), and the host
 * it is behind ('' for none), each as text whatever the entry holds. A hand edit or config sync can put anything there,
 * and an entry that can't be shown must not take with it the menus and lists that show the others. `hyperv`: whether
 * it is a Hyper-V VM, told as specOf tells one, by its VM's id: not by its address, which a desktop at a host named
 * hyperv starts the same way.
 */
export function entryText (extra: ExtraDesktopConfig): { name: string, address: string, via: string, hyperv: boolean } {
    return desktopPolicy('entry_text', desktopObservation(extra))
}

/**
 * One desktop per key: the remote account for its own desktop, plus the RDP server for one behind it (`rdp#<address>`
 * for a direct one).
 */
export function sessionKey (target: Pick<RemoteTarget, 'key'>, spec: Pick<DesktopSpec, 'id'>): string {
    return identity('session_key', target.key, spec.id)
}

/**
 * Whether a desktop signs in without Network Level Authentication without being asked about it first, as xrdp does by
 * design: an xrdp desktop whose kind is trusted (see DesktopSpec.kindTrusted). Every other desktop stops before the
 * password goes as it is to a server that doesn't use it.
 */
export function xrdpUnasked (spec: DesktopSpec): boolean {
    void spec.kind
    return desktopPolicy('xrdp_unasked', desktopObservation(spec))
}

/** A target's key: `user@hostname:port` from `ssh -G` output (config aliases and defaults resolved). */
export function keyFromConfig (out: string, destination: string): string {
    return identity('key_from_config', out, destination)
}

/**
 * Whether some target could have this key now, reached directly or with ssh typed in a tab's console (see nestedKey):
 * it reads the same taken apart and put back together. A key as the plugin made it up to 0.5.0 (see
 * legacyKeyFromConfig) that does could be another target's now (a user name `alice%23ops` then, `alice#ops`'s now).
 */
export function isTargetKey (key: string): boolean {
    return identity('is_target_key', key)
}

/**
 * A target's key as the plugin made it up to 0.5.0: the fields as ssh printed them. It reads as keyFromConfig's does
 * unless a field has a character the identity core now writes as `%xx`; what was kept for the target before is under this one
 * (see RemoteTargets.keyChanged, which moves it).
 */
export function legacyKeyFromConfig (out: string, destination: string): string {
    return identity('legacy_key', out, destination)
}

/**
 * The user, host name and port in a target's key (for a machine reached through a host, see nestedKey, that machine's)
 * as ssh resolved them: the user is what comes before the last `@` and the port what comes after the last `:`, since
 * the identity core escapes delimiter characters in each field, and every `%` in a field is one the identity core wrote.
 */
export function keyFields (key: string): { user: string, host: string, port: string } {
    return identity('key_fields', key)
}

/**
 * The key of a machine reached with `ssh` typed in an SSH tab's console: the tab's key, `>`, and the machine's own as
 * the host there resolves it (`ssh -G`, run there). Everything about that machine comes from that host, which can make
 * it out to be any machine: under the host's own key, what it names is one of its own desktops, never the key (and with
 * it the saved account, the remembered certificate, or the permission to sign in without NLA) of a desktop reached
 * another way.
 */
export function nestedKey (outerKey: string, configOut: string, destination: string): string {
    return identity('nested_key', outerKey, configOut, destination)
}

/**
 * A target's key as it reads, for a list of what is kept by it (Settings › Remote Desktop › Certificates): `%`, `#`,
 * `>`, `@` and `:` as they are rather than as the identity core writes them (control characters stay written so), and a machine
 * reached through a host (see nestedKey) named first, through that host.
 */
export function shownKey (key: string): string {
    return identity('shown_key', key)
}

/**
 * The user in a target's key, as ssh resolved it (not as the key writes it, see keyField): for a machine reached through
 * a host (see nestedKey), that machine's.
 */
export function keyUser (key: string): string {
    return keyFields(key).user
}

/**
 * Who a direct desktop signs in as, as its saved password's key names it (see userScope): DOMAIN\user, or the user
 * name as typed where it names its domain itself (as signInName has it); '' for one that names no user (its sign-in
 * asks who, its domain or not), which keeps the address's password. From its own user name and domain: a saved
 * account's password is the account's (see accountKey), not the desktop's.
 */
export function signsInAs (extra: { username?: unknown, domain?: unknown }): string {
    const username = configText(extra?.username)
    return username ? signInName({ username, domain: configText(extra?.domain) }) : ''
}

/**
 * Whether a login saved with `username` (as typed at a sign-in, the desktop's domain going with one that names none)
 * is for `who` (see signsInAs): how a password saved for an address alone, before each user had their own there, is
 * told to be a profile's.
 */
export function isLoginOf (username: string, who: string): boolean {
    return identity('is_login_of', username, who)
}

/**
 * What a direct desktop's saved password's key adds for who it signs in as (`@user#<who>`, see signsInAs), or '' for a
 * desktop that doesn't say: several profiles can lead to one address, each signing in as someone else, and each finds
 * the password of its own user there. The user is written as the identity core writes a target's, so it has no `#`.
 */
export function userScope (who: string): string {
    return identity('user_scope', who)
}

/**
 * A session, trust or credential key split into the target it belongs to and the desktop id after it, so matching is
 * anchored on whole parts rather than an `endsWith('#'+id)` that a different key could also satisfy. A key is
 * `<target>#<id>`: the target is `rdp` for a direct desktop, `gateway` for a gateway certificate, or `user@host:port`
 * for a desktop behind an SSH host (`<tab's key>><user@host:port>` for a machine reached through one, see nestedKey;
 * no target's key has a `#`, see keyField); the own desktop's key is the bare target, with no id. A credential key
 * may carry a user suffix (`…@user#<who>`, see userScope), which names who a direct desktop's password is for, and then
 * a gateway suffix (`…@gateway#<host:port>`), which names where it is sent; both are returned separately, so the id
 * still compares equal. Neither the id nor the user has a `#`, so neither suffix can be taken for part of either.
 */
export function keyParts (key: string): { target: string, desktopId: string, user: string, gateway: string } {
    return identity('key_parts', key)
}

/**
 * A session, trust or credential key of the target `from`, as the same key of `to` (see RemoteTargets.keyChanged,
 * which moves what was kept under a target's former key): `from` itself (its own desktop), or `from#<id>`, with a user
 * and a gateway suffix on a saved password's key (see keyParts). Null for any other key. Desktop ids have no `#` (see
 * specOf), so a key that has more of them isn't one of `from`'s desktops, whatever it starts with.
 */
export function rekeyed (key: string, from: string, to: string): string | null {
    return identity('rekeyed', key, from, to)
}
