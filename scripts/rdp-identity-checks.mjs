// Exercise the production RDP plugin's compiled identity facade in the packaged WebKit page.
// Synthetic identities only: no keychain entries, profiles or external hosts are changed.
export default [
    ['RDP identities: target escaping, nested hosts, and exact UTF-16 identities', String.raw`
        const api = (await until(() => window.__remoteDesktop)).identities
        const config = 'user alice@corp#ops\nhostname FE80::1%en0@host>name\nport 22:side\n'
        const key = api.keyFromConfig(config, 'unused')
        if (key !== 'alice@corp%23ops@fe80::1%25en0%40host%3Ename:22%3Aside') throw new Error('Target delimiter escaping changed')
        const fields = api.keyFields(key)
        if (fields.user !== 'alice@corp#ops' || fields.host !== 'fe80::1%en0@host>name' || fields.port !== '22:side') throw new Error('Target fields changed')
        const nested = api.nestedKey('outer@jump:22', 'user admin\nhostname DESKTOP\nport 22', '')
        if (nested !== 'outer@jump:22>admin@desktop:22' || !api.isTargetKey(nested)) throw new Error('Nested identity changed')
        if (api.viaMatches('desktop', {key:nested, label:'desktop', via:{}})) throw new Error('Nested target matched a direct via')
        if (api.keyFromConfig('', 'ΟΣ') !== '@ος:22' || api.keyFromConfig('', 'İ') !== '@i\u0307:22') throw new Error('Unicode lowercase changed')
        for (const text of ['\ud800', '\udc00', '\ud800\ud800', '\ufffd', '😀']) {
            const key = api.keyFromConfig('', text)
            if (api.keyFields(key).host !== text) throw new Error('UTF-16 identity was replaced')
        }
        if (api.userScope('\ud800') === api.userScope('\ufffd')) throw new Error('Distinct credential identities collapsed')
        return true
    `],
    ['RDP identities: credential scopes and legacy rekeying stay isolated', String.raw`
        const api = (await until(() => window.__remoteDesktop)).identities
        const session = api.sessionKey({key:'u@host:22'}, {id:'desk'})
        const scoped = session + api.userScope('D\\a#b') + '@gateway#gw:443'
        const parts = api.keyParts(scoped)
        if (parts.target !== 'u@host:22' || parts.desktopId !== 'desk' || parts.user !== '@user#D\\a%23b' || parts.gateway !== '@gateway#gw:443') throw new Error('Credential scope changed')
        if (api.rekeyed(scoped, 'u@host:22', 'v@host:22') !== 'v@host:22#desk@user#D\\a%23b@gateway#gw:443') throw new Error('Rekey lost credential scopes')
        for (const invalid of ['u@host:22#desk#extra', 'otheru@host:22#desk', 'u@host:22#desk@gateway#g@user#u']) {
            if (api.rekeyed(invalid, 'u@host:22', 'v@host:22') !== null) throw new Error('Malformed or unrelated credential key moved')
        }
        if (api.signInName({username:'alice',domain:'DOMAIN'}) !== 'DOMAIN\\alice') throw new Error('Sign-in domain lost')
        if (!api.isLoginOf('alice', 'DOMAIN\\alice') || api.isLoginOf('Alice', 'DOMAIN\\alice')) throw new Error('Login identity case changed')
        if (api.shownKey('u%00%23@h:22>v@x:22') !== 'v@x:22, through u%00#@h:22') throw new Error('Display expanded a control escape')
        const source = api.legacyKeyFromConfig('user a#b\nhostname HOST\nport 22', '')
        const target = api.keyFromConfig('user a#b\nhostname HOST\nport 22', '')
        if (source !== 'a#b@host:22' || target !== 'a%23b@host:22' || api.isTargetKey(source)) throw new Error('Unsafe legacy identity was accepted as canonical')
        return true
    `],
]
