#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Read-only metadata verification; no prompts, platform sends, account IDs or keys.
try {
  const base = path.join(os.homedir(), '.local/share/companion-world-v1');
  const before = JSON.parse(fs.readFileSync(path.join(base, 'operator/recovery-before.json'), 'utf8'));
  const bootChanged = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== before.bootId;
  const token = fs.readFileSync(path.join(base, 'operator/console.token'), 'utf8').trim();
  const get = async route => {
    const r = await fetch('http://127.0.0.1:3082' + route, { headers: { authorization: 'Bearer ' + token } });
    const result = await r.json(); if (!r.ok || !result.ok) throw new Error('RECOVERY_API_UNAVAILABLE'); return result.value;
  };
  const world = await get('/world'), qq = await get('/qq');
  const units = ['companion-authority.service', 'companion-model.service', 'companion-conversation.service', 'companion-qq.service'];
  const services = units.map(unit => ({ unit, active: execFileSync('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '--value'], { encoding: 'utf8' }).trim() === 'active', startedSecondsAfterBoot: Number(execFileSync('systemctl', ['--user', 'show', unit, '-p', 'ActiveEnterTimestampMonotonic', '--value'], { encoding: 'utf8' }).trim()) / 1000000 }));
  const dispatch = JSON.parse(fs.readFileSync(path.join(base, 'qq-data/dispatch.json'), 'utf8')).records;
  const fresh = Object.entries(dispatch).filter(([id]) => !before.dispatchKeys.includes(id)).map(([, value]) => value);
  const canonical = value => value.map(row => JSON.stringify(row)).sort().join('\n');
  const bindings = world.bindings.map(row => ({ sourceId: row.sourceId, personId: row.personId, audience: row.audience }));
  const account = JSON.parse(fs.readFileSync(path.join(base, 'qq-data/settings.json'), 'utf8')).expectedSelfId;
  const quickSelection = JSON.parse(fs.readFileSync(path.join(base, 'qq-runtime/data/config/webui.json'), 'utf8')).autoLoginAccount;
  const environmentAccount = fs.readFileSync(path.join(base, 'qq-runtime/private/napcat.env'), 'utf8').match(/^ACCOUNT=(\d+)$/m)?.[1];
  const result = {
    autoLoginSelectionSaved: account === quickSelection && account === environmentAccount,
    rebootObserved: bootChanged, linger: execFileSync('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value'], { encoding: 'utf8' }).trim() === 'yes',
    services, qqLoggedIn: qq.loggedIn && qq.connected && qq.configured,
    worldPaused: world.world.paused, worldRevisionPreserved: world.world.revision === before.world.revision,
    frozenTimePreserved: world.world.worldNow === before.world.worldNow,
    personaRevisionPreserved: world.persona.revision === before.personaRevision,
    memoryCountsPreserved: JSON.stringify(world.counts) === JSON.stringify(before.counts),
    bindingsPreserved: canonical(bindings) === canonical(before.bindings),
    noHistoricalSend: fresh.every(item => ['paused', 'interrupted'].includes(item.status)),
  };
  result.verified = result.autoLoginSelectionSaved && result.linger && services.every(s => s.active) && result.qqLoggedIn && result.worldPaused && result.worldRevisionPreserved && result.frozenTimePreserved && result.personaRevisionPreserved && result.memoryCountsPreserved && result.bindingsPreserved && result.noHistoricalSend && (!process.argv.includes('--new-boot') || bootChanged);
  process.stdout.write(JSON.stringify(result) + '\n'); if (!result.verified) process.exitCode = 1;
} catch { process.stderr.write('Recovery verification unavailable; no private response or credential was printed.\n'); process.exitCode = 1; }
