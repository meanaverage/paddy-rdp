import { Injectable } from '@angular/core'
import { ConfigService, ProfilesService } from 'tabby-core'
import { RemoteTargets as HostTargets, RemoteTarget, DesktopPane, isRDPTab, RDP_PROFILE_TYPE, Upstream } from 'tabby-tauri/remote/targets'
import { DesktopSpec, DIRECT_KEY, isTargetKey, rekeyed, specOf } from './desktops'
import { formatAddress } from './desktopForm'
import { forgetFormerKey, renameCredentials } from './signin'
export { DesktopPane, RemoteTarget, NestedSSH, SystemSSHTarget, desktopPaneOf, isRDPTab, RDP_PROFILE_TYPE } from 'tabby-tauri/remote/targets'
/** A remote desktop tab's RDP server, reached with a plain TCP connection from this computer (LAN, VPN). */
class DirectTarget implements RemoteTarget {
    readonly key = DIRECT_KEY
    constructor (readonly label: string, readonly direct: DesktopSpec) { }

    async openTcp (host: string, port: number): Promise<Upstream> {
        return { kind: 'tcp', host, port }
    }

    exec (): Promise<string> { return Promise.reject(new Error('A direct connection runs no commands')) }
    // Each connection is its own socket; there is nothing to wait for between them.
    isOpen (): boolean { return true }
}


@Injectable({ providedIn: 'root' })
export class RemoteTargets extends HostTargets {
    constructor (private config: ConfigService, private profiles: ProfilesService) { super() }
    protected profileTarget (pane: DesktopPane): RemoteTarget | null | undefined {
        if (!isRDPTab(pane)) { return undefined }
        const profile = this.savedProfile(pane)
        const spec = profile.options?.via ? null : specOf({ ...profile.options, name: profile.name, wake: undefined })
        return spec ? new DirectTarget(formatAddress(spec.host, spec.port), spec) : null
    }
    /**
     * A remote desktop tab's profile as saved now, with its type's and group's defaults as Tabby resolves a profile
     * when opening it. Not the tab's own: Tabby's proxy of that keeps the options of when the tab opened (saving the
     * profile editor puts new ones in their place), and a restored tab has a copy. The tab's own where it isn't a saved
     * profile (quick connect).
     */
    private savedProfile (pane: DesktopPane): { name?: string, options?: any } {
        const own = pane.profile as { id?: string, name?: string, options?: any }
        const saved = own.id ? (this.config.store.profiles ?? []).find((p: any) => p?.id === own.id && p.type === RDP_PROFILE_TYPE) : null
        return saved ? { name: saved.name, options: this.profiles.getConfigProxyForProfile(saved).options } : own
    }


    /**
     * A target whose key reads otherwise than up to 0.5.0: one of its fields has a character keyFromConfig now writes
     * as `%xx` (the `%` of an IPv6 address's zone, a `#` in a user name). It is the same target, resolved here by ssh
     * from this computer's own config, so what was kept under its former key moves to the new one: the certificates
     * remembered for its desktops and their sharpness now, a saved password the first time it is looked for (see
     * renameCredentials). An entry already kept under the new key stays as it is. What else was kept by its key (desk's
     * key, a "from now on" choice of a machine reached through it) stays behind, and is asked about again: neither
     * gives anything away. Nothing moves where the former key could be another target's key now (see isTargetKey):
     * what is kept under it may then be that one's, and this target's desktops ask again instead.
     *
     * Nor do the saved passwords of a former key with a `#` in it (a user name's): a desktop's key splits at its first
     * `#` (see keyParts), so its desktops' passwords there read as no desktop's, and nothing that forgets or moves a
     * desktop's passwords by its address (removing it, a new user name, gateway or address, the gateway passwords 0.5.0
     * kept, see RemoteDesktopService.gatewayPasswords) has touched them. Moved now, a password forgotten that way would
     * come back. That host's desktops ask for their passwords again instead, and those passwords are forgotten (see
     * forgetFormerKey): no key a target has now has a `#` there, so what is kept under that one can only be this
     * target's, and would otherwise stay kept for good, unused.
     */
    protected keyChanged (from: string, to: string): void {
        if (from === to || isTargetKey(from)) {
            return
        }
        if (!from.includes('#')) {
            renameCredentials(from, to)
        } else {
            forgetFormerKey(from)
        }
        const store = this.config.store.remoteDesktop
        let moved = false
        // The permission to sign in without NLA with them: it holds for one certificate (see holdWithoutNla), which moves.
        // (None under a former key has one, which it needs: 0.5.0 never saved them, and builds since gave them one only
        // under the new keys. Moved all the same, they count for nothing.)
        for (const list of ['trustedCertificates', 'desktopSharpness', 'withoutNla']) {
            const entries: any[] = Array.isArray(store?.[list]) ? store[list] : []
            const taken = new Set(entries.map(e => e?.desktop))
            const renamed = entries.map(e => {
                const desktop = typeof e?.desktop === 'string' ? rekeyed(e.desktop, from, to) : null
                return desktop && !taken.has(desktop) ? { ...e, desktop } : e
            })
            if (renamed.some((e, i) => e !== entries[i])) {
                store[list] = renamed
                moved = true
            }
        }
        if (moved) {
            this.config.save()
        }
    }


}
