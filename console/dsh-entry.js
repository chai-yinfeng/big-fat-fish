// Legacy DSH build input only. The standalone entry never imports this file.
return {
  inject: ['slots', 'locale'],
  apply(ctx) {
    consumeOperatorFragment({ location: window.location, history: window.history, storage: {
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
    } });
    for (const [locale, dictionary] of Object.entries(DICTIONARIES)) ctx.effect(() => ctx.locale.register(NS, locale, flattenDictionary(dictionary)));
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'companion-world', order: 25,
      label: () => ctx.locale.bind(NS)('title'), locale: NS,
      inject: () => ({
        createSession: payload => createDshSession({ payload }),
        navigateSession: (id, close) => {
          const workspace = ctx.get('uiWorkspace');
          if (workspace) { close?.(); return workspace.openSession(id); }
        },
      }),
    }, WorldConsole));
  },
};
