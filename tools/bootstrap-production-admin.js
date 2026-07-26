'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { createRequire } = require('node:module');
const cliAuth = require('firebase-tools/lib/auth');

const PROJECT_ID = 'claimextension-prod';
const ADMIN_EMAIL = 'nocturnaladmin@gmail.com';
const ORGANIZATION_ID = 'platform';
const CONFIRMATION = `${PROJECT_ID}:${ADMIN_EMAIL}`;
const adminRequire = createRequire(path.resolve(__dirname, '../functions/package.json'));
const { initializeApp, deleteApp } = adminRequire('firebase-admin/app');
const { getAuth } = adminRequire('firebase-admin/auth');

function field(value) {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (value && typeof value === 'object') {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, field(item)])) } };
  }
  throw new Error('Unsupported bootstrap field value');
}

function document(name, values) {
  return {
    name: `projects/${PROJECT_ID}/databases/(default)/documents/${name}`,
    fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, field(value)]))
  };
}

async function main() {
  if (process.argv[2] !== '--confirm' || process.argv[3] !== CONFIRMATION) {
    throw new Error(`Refusing bootstrap. Pass: --confirm ${CONFIRMATION}`);
  }
  const account = cliAuth.getGlobalDefaultAccount();
  if (!account || account.user.email !== ADMIN_EMAIL) {
    throw new Error(`Firebase CLI must be authenticated as ${ADMIN_EMAIL}`);
  }
  const token = await cliAuth.getAccessToken(account.tokens.refresh_token, [
    'https://www.googleapis.com/auth/cloud-platform'
  ]);
  const credential = {
    getAccessToken: async () => ({ access_token: token.access_token, expires_in: token.expires_in || 3600 })
  };
  const app = initializeApp({ credential, projectId: PROJECT_ID }, `production-bootstrap-${Date.now()}`);
  const auth = getAuth(app);
  const user = await auth.getUserByEmail(ADMIN_EMAIL);
  if (user.disabled) throw new Error('Refusing to bootstrap a disabled Auth user');
  if (Object.keys(user.customClaims || {}).length) throw new Error('Refusing to overwrite existing custom claims');

  const base = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const protectedDocuments = [
    `organizations/${ORGANIZATION_ID}`,
    `users/${user.uid}`,
    `licences/${ORGANIZATION_ID}`,
    'appConfig/production'
  ];
  for (const name of protectedDocuments) {
    const response = await fetch(`${base}/${name}`, {
      headers: { authorization: `Bearer ${token.access_token}` }
    });
    if (response.ok) throw new Error(`Refusing to overwrite existing document: ${name}`);
    if (response.status !== 404) throw new Error(`Could not preflight ${name}: HTTP ${response.status}`);
  }

  const now = new Date();
  const expiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const auditId = crypto.randomUUID();
  const writes = [
    document(`organizations/${ORGANIZATION_ID}`, {
      name: 'Claim Spark Platform',
      status: 'active',
      plan: 'fixed-pilot',
      maximumUsers: 1,
      createdAt: now,
      updatedAt: now
    }),
    document(`users/${user.uid}`, {
      email: ADMIN_EMAIL,
      displayName: 'Platform Administrator',
      organizationId: ORGANIZATION_ID,
      role: 'platformAdmin',
      accountStatus: 'active',
      createdAt: now,
      updatedAt: now
    }),
    document(`licences/${ORGANIZATION_ID}`, {
      organizationId: ORGANIZATION_ID,
      status: 'active',
      startDate: now,
      expiryDate: expiry,
      maximumUsers: 1,
      monthlyAiLimit: 0,
      updatedAt: now
    }),
    document('appConfig/production', {
      minimumSupportedVersion: '1.9.1',
      maintenanceMode: false,
      updatedAt: now
    }),
    document(`auditLogs/${auditId}`, {
      actorId: user.uid,
      actorRole: 'platformAdmin',
      action: 'production.bootstrap',
      targetType: 'organization',
      targetId: ORGANIZATION_ID,
      details: { organizationId: ORGANIZATION_ID },
      timestamp: now
    })
  ].map(update => ({ update, currentDocument: { exists: false } }));

  const previousClaims = user.customClaims || {};
  try {
    await auth.updateUser(user.uid, { emailVerified: true, disabled: false });
    await auth.setCustomUserClaims(user.uid, {
      organizationId: ORGANIZATION_ID,
      role: 'platformAdmin',
      accountStatus: 'active'
    });
    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.access_token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ writes })
      }
    );
    if (!response.ok) throw new Error(`Firestore bootstrap commit failed: HTTP ${response.status}`);
  } catch (error) {
    await auth.setCustomUserClaims(user.uid, previousClaims);
    await auth.updateUser(user.uid, { emailVerified: user.emailVerified, disabled: user.disabled });
    throw error;
  } finally {
    await deleteApp(app);
  }

  console.log(JSON.stringify({
    projectId: PROJECT_ID,
    email: ADMIN_EMAIL,
    emailVerified: true,
    role: 'platformAdmin',
    organizationId: ORGANIZATION_ID,
    accountStatus: 'active',
    licenceStatus: 'active',
    maximumUsers: 1,
    termDays: 90
  }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
