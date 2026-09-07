#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { ApprovalsManager } = require('./lib/approvals');
const { MfaManager } = require('./lib/mfa');
const { JobManager } = require('./lib/job-manager');
const { createAccessPolicy, TOOL_REQUIREMENTS, PRESETS } = require('./lib/access-policy');
const { detectOsIsolationCapabilities } = require('./lib/sandbox');
const { parseDotEnv } = require('./lib/runtime-diagnostics');
const { OAuthProvider } = require('./lib/oauth-provider');

const ROOT = __dirname;
const approvals = new ApprovalsManager();
const mfa = new MfaManager();

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const [command, sub, ...args] = process.argv.slice(2);

  switch (command) {
    case 'pending':
    case 'approvals': {
      const list = approvals.listPending();
      if (list.length === 0) {
        console.log('No hay solicitudes de aprobación pendientes.');
        return;
      }
      console.log(`\nSOLICITUDES PENDIENTES (${list.length}):\n`);
      for (const item of list) {
        const expiresInSec = Math.max(0, Math.floor((item.expiresAt - Date.now()) / 1000));
        console.log(`  ID:        ${item.id}`);
        console.log(`  Acción:    ${item.tool}`);
        console.log(`  Cliente:   ${item.clientId}`);
        console.log(`  Resumen:   ${item.argsSummary}`);
        console.log(`  Vence en:  ${expiresInSec} segundos`);
        console.log(`  Para aprobar: ./mcpctl.sh approve ${item.id}\n`);
      }
      break;
    }

    case 'approve': {
      const allArgs = [sub, ...args].filter(Boolean);
      const shouldResume = allArgs.includes('--resume');
      const id = allArgs.find(a => a !== '--resume');
      if (!id) {
        console.error('Uso: ./mcpctl.sh approve <id_solicitud> [--resume]');
        process.exit(1);
      }
      try {
        const item = approvals.approve(id);
        console.log(`[OK] Solicitud ${id} aprobada exitosamente.`);
        console.log(`     Acción: ${item.tool}`);
        console.log(`     Cliente: ${item.clientId}`);

        if (shouldResume) {
          const jm = new JobManager();
          if (jm.isPaused()) {
            jm.resumeJobs();
            console.log('[OK] Servidor MCP reanudado de la pausa administrativa.');
          }
          try {
            const { IpcGatewayClient } = require('./lib/ipc-gateway');
            const gateway = new IpcGatewayClient({ autoSpawn: false });
            await gateway.ensureConnected();
            const res = await gateway.callTool(item.tool, item.args || {}, {
              auth: { clientId: item.clientId, authenticated: true },
              approvalId: item.id
            });
            gateway.disconnect();
            console.log(`[OK] Operación ${item.tool} ejecutada inmediatamente (--resume).`);
            const outText = res && res.content && res.content[0] ? res.content[0].text : JSON.stringify(res);
            console.log(`     Resultado:\n${outText}`);
          } catch (_) {
            console.log(`     La solicitud queda aprobada para que el cliente la ejecute.`);
          }
        } else {
          console.log(`     La solicitud se consumirá de forma atómica cuando el cliente la ejecute.`);
        }
      } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'pause': {
      const reason = sub || args.join(' ') || 'Pausa administrativa manual';
      const jm = new JobManager();
      jm.setPaused(true, reason);
      console.log(`[OK] Servidor MCP puesto en pausa administrativa.`);
      console.log(`     Motivo: ${reason}`);
      console.log(`     Nuevas acciones y comandos serán rechazados hasta reanudar: ./mcpctl.sh resume`);
      break;
    }

    case 'resume': {
      const jm = new JobManager();
      jm.resumeJobs();
      console.log(`[OK] Servidor MCP reanudado. Las acciones y trabajos están habilitados.`);
      break;
    }

    case 'reject': {
      const id = sub || args[0];
      if (!id) {
        console.error('Uso: ./mcpctl.sh reject <id_solicitud>');
        process.exit(1);
      }
      try {
        approvals.reject(id, 'Rechazada por el operador local desde mcpctl');
        console.log(`[OK] Solicitud ${id} rechazada.`);
      } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'mfa': {
      const action = sub || 'status';
      if (action === 'status') {
        const st = mfa.getStatus();
        console.log('\nESTADO DE AUTENTICACIÓN MULTIFACTOR (MFA):');
        console.log(`  Habilitado:             ${st.enabled ? 'SÍ' : 'NO'}`);
        console.log(`  WebAuthn / Passkeys:    ${st.webauthnEnrolled ? `SÍ (${st.credentialCount} credenciales)` : 'NO'}`);
        console.log(`  TOTP (App Auth):        ${st.totpEnrolled ? 'SÍ' : 'NO'}`);
        console.log(`  Códigos de recuperación: ${st.recoveryCodesRemaining} restantes`);
        if (!st.enabled) {
          console.log('\nPara enrolar TOTP localmente: ./mcpctl.sh mfa enroll');
        }
      } else if (action === 'enroll' || action === 'enroll-totp') {
        const st = mfa.getStatus();
        if (st.enabled && st.totpEnrolled) {
          console.log('[AVISO] Ya hay un factor TOTP enrolado.');
          const ans = await ask('¿Desea sobrescribirlo y generar nuevos códigos? [s/N]: ');
          if (ans.toLowerCase() !== 's') return;
        }

        const { secret, uri } = mfa.generateTotpSecret('MCP Server Local', 'admin');
        console.log('\n=== ENROLAMIENTO TOTP ===');
        console.log(`Semilla Base32: ${secret}`);
        console.log(`URI de configuración: ${uri}\n`);
        console.log('Ingresá la semilla en tu app de autenticación (Google Authenticator, Bitwarden, etc.).');
        const code = await ask('Ingresá el código de 6 dígitos para verificar y activar: ');

        try {
          const res = mfa.verifyAndEnableTotp(secret, code);
          console.log('\n[OK] TOTP activado exitosamente.');
          console.log('\n=== CÓDIGOS DE RECUPERACIÓN (GUARDALOS EN LUGAR SEGURO) ===');
          console.log('Cada código es de uso único y permite ingresar si perdés el autenticador:');
          for (const c of res.recoveryCodes) {
            console.log(`  * ${c}`);
          }
          console.log('=========================================================\n');
        } catch (err) {
          console.error(`\n[ERROR] No se pudo activar TOTP: ${err.message}`);
          process.exit(1);
        }
      } else if (action === 'reset') {
        const ans = await ask('¿Está seguro de que desea reiniciar la configuración MFA? [s/N]: ');
        if (ans.toLowerCase() === 's') {
          mfa.resetMfa();
          console.log('[OK] MFA ha sido restablecido.');
        }
      } else {
        console.log('Uso: ./mcpctl.sh mfa [status|enroll|reset]');
      }
      break;
    }

    case 'revoke': {
      const clientId = sub || args[0];
      if (!clientId) {
        console.error('Uso: ./mcpctl.sh revoke <clientId>');
        process.exit(1);
      }
      const fileEnv = parseDotEnv(path.join(ROOT, '.env'));
      const storePath = path.resolve(fileEnv.MCP_OAUTH_STORE || '.private/oauth-state.json');
      const provider = new OAuthProvider({ storePath });
      const revoked = provider.revokeClientSessions(clientId);
      console.log(`[OK] Se revocaron ${revoked} tokens/sesiones del cliente ${clientId}.`);
      break;
    }

    case 'diagnose': {
      const fileEnv = parseDotEnv(path.join(ROOT, '.env'));
      const env = { ...fileEnv, ...process.env };
      const policy = createAccessPolicy(env, Object.keys(TOOL_REQUIREMENTS));
      const summary = policy.summary();
      const caps = detectOsIsolationCapabilities();

      console.log('\n========================================================================');
      console.log(' DIAGNÓSTICO DE SEGURIDAD Y PERMISOS MCP');
      console.log('========================================================================');
      console.log(`Perfil configurado:       ${summary.label} (${summary.profile})`);
      console.log(`Herramientas permitidas:  ${summary.allowedToolCount}`);
      console.log(`Herramientas bloqueadas:  ${summary.blockedToolCount}`);
      console.log(`Aislamiento de SO:        ${caps.hasOsIsolation ? `DISPONIBLE (${caps.mechanism})` : 'NO DISPONIBLE'}`);
      console.log(`  - Bubblewrap (bwrap):   ${caps.hasBwrap ? 'Instalado' : 'No encontrado'}`);
      console.log(`  - Usuario dedicado:     ${caps.isDedicatedUser ? 'Activo' : 'No configurado'}`);
      console.log(`  - Sandboxing systemd:   ${caps.inSystemd ? 'Activo' : 'Inactivo'}`);
      console.log(`Confirmaciones humanas:   ${summary.criticalConfirmations ? 'ACTIVADAS' : 'DESACTIVADAS'}`);
      console.log(`Ejecución como root:      ${summary.runAsRoot ? 'SÍ (Peligro)' : 'NO (Usuario normal)'}`);

      if (summary.profile === 'trabajo_restringido' && !caps.hasOsIsolation) {
        console.log('\n[ALERTA CRÍTICA] El perfil trabajo_restringido está activo pero no hay aislamiento');
        console.log('                 de SO disponible. El ejecutor fallará cerrado ante llamadas no aisladas.');
      }

      if (summary.warnings.length > 0) {
        console.log('\nAvisos de política:');
        for (const w of summary.warnings) console.log(`  ! ${w}`);
      }
      console.log('========================================================================\n');
      break;
    }

    default:
      console.error(`Comando desconocido: ${command}`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});
