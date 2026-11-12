/**
 * Client half of the Anthropic-account bundle.
 *
 * Adds one "Account connections" card block at the bottom of Settings → Models
 * (the `settings.models.footer` seat). Each card starts the official vendor CLI
 * sign-in through the Host, shows the authorize URL and the code to type, and
 * accepts the authorization code the Claude page displays. Nothing secret is
 * held here: the Host owns the process and the credential plane.
 */

window.__ModuleLoader__.load({
  id: 'dsh-anthropic-account',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'anthropicAccount.signIn'
    const STYLE_ID = 'anthropic-account-connections-styles'
    /** Flows that are still moving; the page polls faster while one is live. */
    const ACTIVE = new Set(['starting', 'awaiting-code', 'awaiting-approval', 'finishing'])

    const en = {
      title: 'Account connections',
      intro: 'Connect your Claude and ChatGPT subscriptions once; their models and quotas then appear in the harness.',
      claudeName: 'Claude (Pro/Max)',
      codexName: 'ChatGPT (Codex)',
      connected: 'Connected',
      connect: 'Sign in',
      reconnect: 'Sign in again',
      opening: 'Opening the sign-in page…',
      finishing: 'Finalizing…',
      awaitingCode: 'Waiting for the code',
      awaitingApproval: 'Waiting for approval',
      cancel: 'Cancel',
      openPage: 'Open the page',
      codeLabel: 'Authorization code',
      codePlaceholder: 'Paste the code shown by the page',
      validate: 'Validate',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed; select the code manually.',
      claudeIdleHint: 'Runs `claude auth login`; the browser opens automatically.',
      codexIdleHint: 'Runs `codex login --device-auth`; a one-time code is shown here.',
      claudeStep1: 'Sign in to claude.com in the opened tab and authorize the connection.',
      claudeStep2: 'Copy the code the page displays.',
      claudeStep3: 'Paste it below and validate.',
      codexStep1: 'Open the page and sign in to ChatGPT.',
      codexStep2: 'Enter the one-time code above.',
      deviceCode: 'One-time code',
      serviceMissing: 'The Host subprocess service is unavailable; update the Harness or enable it to sign in here.',
      unavailable: 'Sign-in unavailable',
      errorPrefix: 'Sign-in failed',
    }
    const fr = {
      title: 'Connexions des comptes',
      intro: 'Connectez une fois vos abonnements Claude et ChatGPT : leurs modèles et quotas apparaissent ensuite dans le harnais.',
      claudeName: 'Claude (Pro/Max)',
      codexName: 'ChatGPT (Codex)',
      connected: 'Connecté',
      connect: 'Se connecter',
      reconnect: 'Se reconnecter',
      opening: 'Ouverture de la page de connexion…',
      finishing: 'Finalisation…',
      awaitingCode: 'En attente du code',
      awaitingApproval: 'En attente de validation',
      cancel: 'Annuler',
      openPage: 'Ouvrir la page',
      codeLabel: 'Code d’autorisation',
      codePlaceholder: 'Collez le code affiché par la page',
      validate: 'Valider',
      copy: 'Copier',
      copied: 'Copié',
      copyFailed: 'Copie impossible ; sélectionnez le code à la main.',
      claudeIdleHint: 'Lance `claude auth login` ; le navigateur s’ouvre automatiquement.',
      codexIdleHint: 'Lance `codex login --device-auth` ; un code à usage unique s’affiche ici.',
      claudeStep1: 'Connectez-vous à claude.com dans l’onglet ouvert et autorisez la connexion.',
      claudeStep2: 'Copiez le code affiché par la page.',
      claudeStep3: 'Collez-le ci-dessous puis validez.',
      codexStep1: 'Ouvrez la page et connectez-vous à ChatGPT.',
      codexStep2: 'Saisissez le code à usage unique ci-dessus.',
      deviceCode: 'Code à usage unique',
      serviceMissing: 'Le service de sous-processus du Host est indisponible ; mettez le harnais à jour ou activez-le pour vous connecter ici.',
      unavailable: 'Connexion indisponible',
      errorPrefix: 'Échec de la connexion',
    }
    const es = {
      title: 'Conexiones de cuentas',
      intro: 'Conecta una vez tus suscripciones de Claude y ChatGPT; sus modelos y cuotas aparecerán después.',
      claudeName: 'Claude (Pro/Max)',
      codexName: 'ChatGPT (Codex)',
      connected: 'Conectado',
      connect: 'Iniciar sesión',
      reconnect: 'Volver a conectar',
      opening: 'Abriendo la página…',
      finishing: 'Finalizando…',
      awaitingCode: 'Esperando el código',
      awaitingApproval: 'Esperando aprobación',
      cancel: 'Cancelar',
      openPage: 'Abrir la página',
      codeLabel: 'Código de autorización',
      codePlaceholder: 'Pega el código que muestra la página',
      validate: 'Validar',
      copy: 'Copiar',
      copied: 'Copiado',
      copyFailed: 'No se pudo copiar; selecciona el código.',
      claudeIdleHint: 'Ejecuta `claude auth login`; el navegador se abre solo.',
      codexIdleHint: 'Ejecuta `codex login --device-auth`; aquí aparece un código de un solo uso.',
      claudeStep1: 'Inicia sesión en claude.com y autoriza la conexión.',
      claudeStep2: 'Copia el código que muestra la página.',
      claudeStep3: 'Pégalo abajo y valida.',
      codexStep1: 'Abre la página e inicia sesión en ChatGPT.',
      codexStep2: 'Introduce el código de un solo uso.',
      deviceCode: 'Código de un solo uso',
      serviceMissing: 'El servicio de subprocesos del Host no está disponible.',
      unavailable: 'Inicio de sesión no disponible',
      errorPrefix: 'Error de conexión',
    }
    const de = {
      title: 'Kontoverbindungen',
      intro: 'Verbinde Claude und ChatGPT einmal; danach erscheinen ihre Modelle und Kontingente.',
      claudeName: 'Claude (Pro/Max)',
      codexName: 'ChatGPT (Codex)',
      connected: 'Verbunden',
      connect: 'Anmelden',
      reconnect: 'Erneut anmelden',
      opening: 'Anmeldeseite wird geöffnet…',
      finishing: 'Abschluss…',
      awaitingCode: 'Warte auf den Code',
      awaitingApproval: 'Warte auf Freigabe',
      cancel: 'Abbrechen',
      openPage: 'Seite öffnen',
      codeLabel: 'Autorisierungscode',
      codePlaceholder: 'Füge den Code der Seite ein',
      validate: 'Bestätigen',
      copy: 'Kopieren',
      copied: 'Kopiert',
      copyFailed: 'Kopieren fehlgeschlagen; Code manuell markieren.',
      claudeIdleHint: 'Startet `claude auth login`; der Browser öffnet sich.',
      codexIdleHint: 'Startet `codex login --device-auth`; hier erscheint ein Einmalcode.',
      claudeStep1: 'Melde dich bei claude.com an und autorisiere die Verbindung.',
      claudeStep2: 'Kopiere den angezeigten Code.',
      claudeStep3: 'Füge ihn unten ein und bestätige.',
      codexStep1: 'Öffne die Seite und melde dich bei ChatGPT an.',
      codexStep2: 'Gib den Einmalcode ein.',
      deviceCode: 'Einmalcode',
      serviceMissing: 'Der Host-Subprozessdienst ist nicht verfügbar.',
      unavailable: 'Anmeldung nicht verfügbar',
      errorPrefix: 'Anmeldung fehlgeschlagen',
    }

    const CSS = `
      .dsa_panel { display: flex; flex-direction: column; gap: 12px; margin-top: 4px; }
      .dsa_title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
      .dsa_intro { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
      .dsa_card { border: 0.5px solid var(--dsw-alias-settings-card-stroke); background: var(--dsw-alias-settings-card-fill); border-radius: var(--dsw-radius-xl); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
      .dsa_head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .dsa_name { font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); }
      .dsa_state { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
      .dsa_dot { box-sizing: border-box; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
      .dsa_dot_on { background: var(--dsw-alias-state-success-primary); }
      .dsa_dot_err { background: var(--dsw-alias-state-error-primary); }
      .dsa_actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .dsa_btn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 32px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; }
      @media (hover: hover) { .dsa_btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); } }
      .dsa_btn_primary { border: none; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
      @media (hover: hover) { .dsa_btn_primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); } }
      .dsa_btn:disabled { opacity: 0.5; cursor: default; }
      .dsa_input { box-sizing: border-box; height: 32px; flex: 1 1 220px; min-width: 200px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
      .dsa_input:focus { outline: none; border-color: var(--dsw-alias-border-l1); }
      .dsa_hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .dsa_error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
      .dsa_ok { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); }
      .dsa_url { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); word-break: break-all; max-height: 48px; overflow: auto; }
      .dsa_code { display: inline-block; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 16px; letter-spacing: 1px; font-weight: 600; color: var(--dsw-alias-label-primary); padding: 2px 8px; border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-interactive-bg-hover); }
      .dsa_steps { margin: 0; padding-left: 18px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .dsa_steps li { margin: 0; }
    `

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function ConnectionsPanel({ t }) {
      const [snapshot, setSnapshot] = React.useState(null)
      const [code, setCode] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')

      React.useEffect(() => {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return () => {
          const current = document.getElementById(STYLE_ID)
          if (current) current.remove()
        }
      }, [])

      const load = React.useCallback(async () => {
        try {
          const response = await fetch('api/anthropic-account/status', {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) return
          const payload = await response.json()
          if (payload && payload.ok !== false) setSnapshot(payload)
        } catch {
          // keep the last reading; the next poll retries
        }
      }, [])

      const active = Boolean(snapshot) && [snapshot.claude?.state, snapshot.codex?.state].some((state) => ACTIVE.has(state))
      React.useEffect(() => {
        let cancelled = false
        let timer
        const tick = async () => {
          await load()
          if (!cancelled) timer = setTimeout(tick, active ? 1200 : 5000)
        }
        void tick()
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [active, load])

      const post = React.useCallback(async (path, body) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${response.status}`)
        return payload
      }, [])

      const run = async (key, operation) => {
        setBusy(key)
        setError('')
        setNotice('')
        try {
          await operation()
          await load()
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy('')
        }
      }

      const start = (provider) => run(provider, () => post(`api/anthropic-account/${provider}/start`))
      const cancel = (provider) => run(`cancel-${provider}`, () => post('api/anthropic-account/cancel', { provider }))
      const openPage = (url) => run('open', () => post('api/anthropic-account/open', { url }))
      const submit = () =>
        run('code', async () => {
          await post('api/anthropic-account/claude/code', { code: code.trim() })
          setCode('')
        })

      const copy = async (value) => {
        try {
          await navigator.clipboard.writeText(value)
          setNotice(t('copied'))
        } catch {
          setError(t('copyFailed'))
        }
      }

      if (snapshot === null) return null
      const signInAvailable = snapshot.available?.signIn !== false
      const stateText = (state) => {
        if (state === 'starting') return t('opening')
        if (state === 'awaiting-code') return t('awaitingCode')
        if (state === 'awaiting-approval') return t('awaitingApproval')
        if (state === 'finishing') return t('finishing')
        if (state === 'connected') return t('connected')
        if (state === 'error') return t('errorPrefix')
        return t('unavailable')
      }

      const card = (kind) => {
        const data = snapshot[kind] ?? {}
        const state = data.state ?? 'idle'
        const connected = data.connected === true
        const working = busy === kind || (kind === 'claude' && busy === 'code')
        const name = kind === 'claude' ? t('claudeName') : t('codexName')
        const plan = kind === 'claude' && typeof data.plan === 'string' && data.plan !== '' ? data.plan : ''
        const dot = connected ? 'dsa_dot dsa_dot_on' : state === 'error' ? 'dsa_dot dsa_dot_err' : 'dsa_dot'
        const busyActive = ACTIVE.has(state)
        const canStart = !connected && (state === 'idle' || state === 'error')
        return h(
          'div',
          { className: 'dsa_card', key: kind },
          h(
            'div',
            { className: 'dsa_head' },
            h('span', { className: 'dsa_name' }, name),
            h(
              'span',
              { className: 'dsa_state' },
              h('span', { className: dot }),
              connected ? `${t('connected')}${plan ? ` · ${plan}` : ''}` : stateText(state),
            ),
          ),
          data.error ? h('p', { className: 'dsa_error' }, data.error) : null,
          canStart
            ? h(
                'div',
                { className: 'dsa_actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsa_btn dsa_btn_primary',
                    disabled: working || !signInAvailable,
                    onClick: () => start(kind),
                  },
                  working ? t('opening') : t('connect'),
                ),
                h('span', { className: 'dsa_hint' }, kind === 'claude' ? t('claudeIdleHint') : t('codexIdleHint')),
              )
            : null,
          busyActive && state !== 'awaiting-code' && state !== 'awaiting-approval'
            ? h('p', { className: 'dsa_hint' }, state === 'starting' ? t('opening') : t('finishing'))
            : null,
          state === 'awaiting-approval'
            ? h(
                'div',
                { className: 'dsa_actions' },
                data.url ? h('code', { className: 'dsa_url' }, data.url) : null,
                data.url ? h('button', { type: 'button', className: 'dsa_btn', onClick: () => openPage(data.url) }, t('openPage')) : null,
              )
            : null,
          state === 'awaiting-approval' && data.code
            ? h(
                'div',
                { className: 'dsa_actions' },
                h('span', { className: 'dsa_hint' }, t('deviceCode')),
                h('span', { className: 'dsa_code' }, data.code),
                h('button', { type: 'button', className: 'dsa_btn', onClick: () => copy(data.code) }, t('copy')),
              )
            : null,
          state === 'awaiting-approval'
            ? h(
                'ol',
                { className: 'dsa_steps' },
                h('li', null, t('codexStep1')),
                h('li', null, t('codexStep2')),
              )
            : null,
          state === 'awaiting-code'
            ? h(
                'div',
                { className: 'dsa_actions' },
                data.url ? h('code', { className: 'dsa_url' }, data.url) : null,
                data.url ? h('button', { type: 'button', className: 'dsa_btn', onClick: () => openPage(data.url) }, t('openPage')) : null,
              )
            : null,
          state === 'awaiting-code'
            ? h('ol', { className: 'dsa_steps' }, h('li', null, t('claudeStep1')), h('li', null, t('claudeStep2')), h('li', null, t('claudeStep3')))
            : null,
          state === 'awaiting-code'
            ? h(
                'div',
                { className: 'dsa_actions' },
                h('input', {
                  className: 'dsa_input',
                  value: code,
                  placeholder: t('codePlaceholder'),
                  'aria-label': t('codeLabel'),
                  onChange: (event) => setCode(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      if (code.trim() !== '') void submit()
                    }
                  },
                }),
                h(
                  'button',
                  { type: 'button', className: 'dsa_btn dsa_btn_primary', disabled: working || code.trim() === '', onClick: () => submit() },
                  working ? t('finishing') : t('validate'),
                ),
              )
            : null,
          busyActive
            ? h(
                'div',
                { className: 'dsa_actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsa_btn',
                    disabled: busy.startsWith('cancel-'),
                    onClick: () => cancel(kind),
                  },
                  t('cancel'),
                ),
              )
            : null,
          connected
            ? h(
                'div',
                { className: 'dsa_actions' },
                h('button', { type: 'button', className: 'dsa_btn', disabled: working || !signInAvailable, onClick: () => start(kind) }, working ? t('opening') : t('reconnect')),
              )
            : null,
        )
      }

      return h(
        'section',
        { className: 'dsa_panel', 'aria-label': t('title') },
        h('h3', { className: 'dsa_title' }, t('title')),
        h('p', { className: 'dsa_intro' }, t('intro')),
        !signInAvailable ? h('p', { className: 'dsa_error' }, t('serviceMissing')) : null,
        card('claude'),
        card('codex'),
        notice ? h('p', { className: 'dsa_ok', role: 'status' }, notice) : null,
        error ? h('p', { className: 'dsa_error', role: 'alert' }, error) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const dictionaries = { en, fr, es, de, zh: en, ja: en, ru: en, pt: en }
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'anthropic-account: sign-in dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.models.footer', () =>
          ctx.slots.register(
            { name: 'settings.models.footer', id: 'anthropic-account', order: 20 },
            () => h(ConnectionsPanel, { t }),
          ),
        )
      },
    }
  },
})
