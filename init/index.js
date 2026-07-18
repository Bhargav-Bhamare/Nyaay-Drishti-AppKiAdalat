'use strict';

/**
 * init/index.js
 *
 * Sandbox database seeding script.
 * Clears and re-seeds the NyaayDrishti database with:
 *   - 15 sample cases (from ./caseData.js)
 *
 * Auth notes:
 *   Judge and Court Master login credentials live in data/tempusers.js and
 *   are authenticated entirely in-memory by authController.js — no User
 *   collection is needed for those roles.
 *
 *   The Case schema requires a lawyerId (ObjectId ref to Lawyer). Since the
 *   sample cases are not owned by a real lawyer we use a stable placeholder
 *   ObjectId so the documents pass validation and the cause-list queries work.
 *
 * Usage:
 *   node init/index.js
 */

const mongoose = require('mongoose');
const Case     = require('../model/case');
const Lawyer   = require('../model/lawyer');
const rawCases = require('./caseData.js');
const tempUsers = require('../data/tempusers.js');

const MONGO_URI = 'mongodb://localhost:27017/NyaayDrishti';

// Stable placeholder ObjectId — used as lawyerId on all sample cases
// so they pass schema validation without needing a real Lawyer document.
const PLACEHOLDER_LAWYER_ID = new mongoose.Types.ObjectId('000000000000000000000001');

async function initializeDatabase() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB →', MONGO_URI);

    // ── 1. Clear existing records ───────────────────────────────────────────
    const [deletedCases, deletedLawyers] = await Promise.all([
      Case.deleteMany({}),
      Lawyer.deleteMany({}),
    ]);
    console.log(`Cleared: ${deletedCases.deletedCount} cases, ${deletedLawyers.deletedCount} lawyers`);

    // ── 2. Seed sample cases ────────────────────────────────────────────────
    // Attach the placeholder lawyerId to every case so required validation passes.
    const casesToInsert = rawCases.map(c => ({
      ...c,
      lawyerId: PLACEHOLDER_LAWYER_ID,
    }));

    const insertedCases = await Case.insertMany(casesToInsert);
    console.log(`Seeded: ${insertedCases.length} cases`);

    // ── 3. Print sandbox credentials ────────────────────────────────────────
    console.log('\n════════════════════════════════════════════');
    console.log('  NyaayDrishti — Sandbox Ready');
    console.log('════════════════════════════════════════════');
    console.log('  Server  : http://localhost:8080');
    console.log('  Login   : http://localhost:8080/login\n');
    console.log('  Test credentials (from data/tempusers.js):');
    tempUsers.forEach(u => {
      const plainPassword = u.email === 'judge@court.com'       ? 'judge123'
                          : u.email === 'courtmaster@court.com' ? 'court123'
                          : '(see tempusers.js)';
      console.log(`\n  Role    : ${u.role}`);
      console.log(`  Email   : ${u.email}`);
      console.log(`  Password: ${plainPassword}`);
      const redirect = u.role === 'JUDGE'       ? '/judge/dashboard'
                     : u.role === 'COURTMASTER' ? '/courtmaster/dashboard'
                     : '/lawyer/dashboard';
      console.log(`  Lands on: http://localhost:8080${redirect}`);
    });
    console.log('\n════════════════════════════════════════════\n');

  } catch (err) {
    console.error('Seeding failed:', err.message);
    throw err;
  } finally {
    await mongoose.connection.close();
    console.log('MongoDB connection closed.');
  }
}

initializeDatabase();
