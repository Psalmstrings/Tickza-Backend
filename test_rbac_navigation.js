import { requireApproved, protect } from './middleware/authMiddleware.js';

let testsPassed = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    testsPassed++;
    console.log(`  [PASS] Test ${totalTests}: ${message}`);
  } else {
    console.error(`  [FAIL] Test ${totalTests}: ${message}`);
  }
}

console.log('====================================================');
console.log('   TICKZA ROLE-BASED ACCESS & NAVIGATION TESTS      ');
console.log('====================================================');

// Test 1: requireApproved rejects unauthenticated request
{
  const req = {};
  let statusSent = null;
  let jsonSent = null;
  const res = {
    status: (s) => {
      statusSent = s;
      return {
        json: (j) => { jsonSent = j; }
      };
    }
  };
  let nextCalled = false;
  requireApproved(req, res, () => { nextCalled = true; });

  assert(statusSent === 401 && !nextCalled, 'Unauthenticated user rejected with 401');
}

// Test 2: requireApproved rejects suspended user
{
  const req = {
    user: {
      role: 'APPROVED_USER',
      status: 'SUSPENDED',
      suspensionReason: 'Terms violation'
    }
  };
  let statusSent = null;
  let jsonSent = null;
  const res = {
    status: (s) => {
      statusSent = s;
      return {
        json: (j) => { jsonSent = j; }
      };
    }
  };
  let nextCalled = false;
  requireApproved(req, res, () => { nextCalled = true; });

  assert(statusSent === 403 && jsonSent?.code === 'ACCOUNT_SUSPENDED' && !nextCalled, 'Suspended user rejected with 403 ACCOUNT_SUSPENDED');
}

// Test 3: requireApproved rejects ordinary attendee (USER role)
{
  const req = {
    user: {
      role: 'USER',
      status: 'APPROVED'
    }
  };
  let statusSent = null;
  let jsonSent = null;
  const res = {
    status: (s) => {
      statusSent = s;
      return {
        json: (j) => { jsonSent = j; }
      };
    }
  };
  let nextCalled = false;
  requireApproved(req, res, () => { nextCalled = true; });

  assert(statusSent === 403 && jsonSent?.code === 'ACCOUNT_APPROVAL_REQUIRED' && !nextCalled, 'Ordinary attendee (USER role) rejected with 403 ACCOUNT_APPROVAL_REQUIRED');
}

// Test 4: requireApproved rejects PENDING_USER
{
  const req = {
    user: {
      role: 'PENDING_USER',
      status: 'PENDING'
    }
  };
  let statusSent = null;
  let jsonSent = null;
  const res = {
    status: (s) => {
      statusSent = s;
      return {
        json: (j) => { jsonSent = j; }
      };
    }
  };
  let nextCalled = false;
  requireApproved(req, res, () => { nextCalled = true; });

  assert(statusSent === 403 && jsonSent?.code === 'ACCOUNT_APPROVAL_REQUIRED' && !nextCalled, 'Pending user rejected with 403 ACCOUNT_APPROVAL_REQUIRED');
}

// Test 5: requireApproved accepts APPROVED_USER with status APPROVED
{
  const req = {
    user: {
      role: 'APPROVED_USER',
      status: 'APPROVED'
    }
  };
  let nextCalled = false;
  requireApproved(req, {}, () => { nextCalled = true; });

  assert(nextCalled === true, 'Approved organizer (APPROVED_USER + APPROVED) allowed to proceed');
}

// Test 6: requireApproved accepts ORGANIZER with status APPROVED
{
  const req = {
    user: {
      role: 'ORGANIZER',
      status: 'APPROVED'
    }
  };
  let nextCalled = false;
  requireApproved(req, {}, () => { nextCalled = true; });

  assert(nextCalled === true, 'Approved organizer (ORGANIZER + APPROVED) allowed to proceed');
}

// Test 7: requireApproved accepts ADMIN
{
  const req = {
    user: {
      role: 'ADMIN',
      status: 'APPROVED'
    }
  };
  let nextCalled = false;
  requireApproved(req, {}, () => { nextCalled = true; });

  assert(nextCalled === true, 'Platform ADMIN allowed to proceed');
}

// Test 8: requireApproved accepts SUPER_ADMIN
{
  const req = {
    user: {
      role: 'SUPER_ADMIN',
      status: 'APPROVED'
    }
  };
  let nextCalled = false;
  requireApproved(req, {}, () => { nextCalled = true; });

  assert(nextCalled === true, 'Platform SUPER_ADMIN allowed to proceed');
}

console.log('====================================================');
console.log(`RESULTS: ${testsPassed}/${totalTests} TESTS PASSED`);
console.log('====================================================');

if (testsPassed === totalTests) {
  process.exit(0);
} else {
  process.exit(1);
}
