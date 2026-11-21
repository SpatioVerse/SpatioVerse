import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as nodeTest from 'node:test';
import evalSuite from '@/fixtures/eval-cases.json';
import { compactDemoScene, flagshipScene } from '@/fixtures/demoScene';
import {
  ConstraintIssueSchema,
  FT_TO_METERS,
  ShopSceneSchema,
  type ConstraintIssue,
  type ConstraintIssueCode,
  type ShopScene,
} from '@/lib/schema';

type TestBody = () => void | Promise<void>;
type SuiteFn = (name: string, fn: () => void) => void;
type TestRunner = {
  describe: SuiteFn;
  it: (name: string, fn: TestBody) => void;
  todo: (name: string) => void;
};

type EvalCaseRecord = (typeof evalSuite.cases)[number];

type ValidationResultLike = {
  valid?: boolean;
  issues: ConstraintIssue[];
  summary?: {
    newPurchaseCents?: number;
  };
};

type ValidateSceneRawOutput = ConstraintIssue[] | ValidationResultLike;
type ValidateSceneFn = (scene: ShopScene) => ValidateSceneRawOutput;

const REQUIRED_CATEGORIES = [
  'fits',
  'collisions',
  'blocked-entrance',
  'reduced-budget',
  'missing-dimensions',
  'reused-owned-fixture',
  'no-drilling-violation',
  'alternate-entrance',
] as const;

function resolveRepoRoot(): string {
  if (typeof __dirname === 'string') {
    const fromDirname = path.resolve(__dirname, '..');
    if (fs.existsSync(path.join(fromDirname, 'lib', 'schema.ts'))) {
      return fromDirname;
    }
  }
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'lib', 'schema.ts'))) {
    return cwd;
  }
  return path.resolve(cwd, '..');
}

function resolveTestRunnerSync(): TestRunner {
  if (process.env.VITEST) {
    const repoPkg = path.join(resolveRepoRoot(), 'package.json');
    const localRequire = createRequire(repoPkg);
    const vitestMod = localRequire('vitest') as {
      describe: SuiteFn;
      it: ((name: string, fn: TestBody) => void) & {
        todo: (name: string) => void;
      };
    };

    return {
      describe: vitestMod.describe,
      it: vitestMod.it,
      todo: (name: string) => vitestMod.it.todo(name),
    };
  }

  return {
    describe: (name, fn) => {
      void nodeTest.describe(name, fn);
    },
    it: (name, fn) => {
      void nodeTest.it(name, fn);
    },
    todo: (name) => {
      void nodeTest.it(
        name,
        {
          todo: 'Blocked until lib/constraints.ts exporting validateScene is merged into main',
        },
        () => {}
      );
    },
  };
}

function hasConstraintsModuleOnDisk(): boolean {
  const root = resolveRepoRoot();
  return (
    fs.existsSync(path.join(root, 'lib', 'constraints.ts')) ||
    fs.existsSync(path.join(root, 'lib', 'constraints.js'))
  );
}

let cachedValidateScene: ValidateSceneFn | null | undefined;

async function loadValidateScene(): Promise<ValidateSceneFn | null> {
  if (cachedValidateScene !== undefined) {
    return cachedValidateScene;
  }

  if (!hasConstraintsModuleOnDisk()) {
    cachedValidateScene = null;
    return null;
  }

  const constraintsSpecifier = '../lib/constraints';
  let mod: Record<string, unknown>;

  if (!process.env.VITEST && typeof __filename === 'string') {
    const localRequire = createRequire(__filename);
    mod = localRequire(constraintsSpecifier) as Record<string, unknown>;
  } else {
    mod = (await import(
      /* webpackIgnore: true */ constraintsSpecifier
    )) as Record<string, unknown>;
  }

  if (typeof mod.validateScene === 'function') {
    cachedValidateScene = mod.validateScene as ValidateSceneFn;
    return cachedValidateScene;
  }

  cachedValidateScene = null;
  return null;
}

function normalizeValidationOutput(raw: ValidateSceneRawOutput): {
  valid: boolean;
  issues: ConstraintIssue[];
  reportedNewPurchaseCents?: number;
} {
  if (Array.isArray(raw)) {
    for (const issue of raw) {
      ConstraintIssueSchema.parse(issue);
    }
    const hasError = raw.some((issue) => issue.severity === 'error');
    return {
      valid: !hasError,
      issues: raw,
    };
  }

  if (raw && typeof raw === 'object' && Array.isArray(raw.issues)) {
    for (const issue of raw.issues) {
      ConstraintIssueSchema.parse(issue);
    }
    const hasError = raw.issues.some((issue) => issue.severity === 'error');
    const valid = typeof raw.valid === 'boolean' ? raw.valid : !hasError;
    assert.equal(
      valid,
      !hasError,
      'validateScene result.valid must match absence of error-severity issues'
    );
    return {
      valid,
      issues: raw.issues,
      reportedNewPurchaseCents: raw.summary?.newPurchaseCents,
    };
  }

  throw new Error(
    'validateScene returned an unexpected shape; expected ConstraintIssue[] or { valid, issues }'
  );
}

function uniqueSortedCodes(
  issues: ConstraintIssue[],
  severity: 'error' | 'warning'
): ConstraintIssueCode[] {
  return Array.from(
    new Set(issues.filter((i) => i.severity === severity).map((i) => i.code))
  ).sort();
}

function computeExpectedNewPurchaseCents(scene: ShopScene): number {
  return scene.objects.reduce((sum, obj) => {
    if (obj.source === 'owned') {
      return sum;
    }
    return sum + (obj.product?.priceCents ?? 0);
  }, 0);
}

const runner = resolveTestRunnerSync();
const constraintsAvailable = hasConstraintsModuleOnDisk();

runner.describe('SpaceStage evaluation fixtures & shared schema contract', () => {
  runner.it(
    'defines all 8 required independent small-store scenarios with unique IDs',
    () => {
      assert.equal(evalSuite.cases.length, 8);

      const ids = evalSuite.cases.map((c) => c.id);
      assert.equal(new Set(ids).size, 8, 'Each eval case must have a unique id');

      const categories = evalSuite.cases.map((c) => c.category);
      assert.deepEqual(categories, [...REQUIRED_CATEGORIES]);
    }
  );

  runner.it(
    'validates every eval scenario and demo preset against ShopSceneSchema in meters',
    () => {
      assert.equal(FT_TO_METERS, 0.3048);

      const parsedCompact = ShopSceneSchema.parse(compactDemoScene);
      const parsedFlagship = ShopSceneSchema.parse(flagshipScene);
      assert.ok(parsedCompact.room.width > 3.6 && parsedCompact.room.width < 3.7);
      assert.ok(parsedFlagship.room.width > 7.3 && parsedFlagship.room.width < 7.4);

      for (const testCase of evalSuite.cases) {
        const parsedScene = ShopSceneSchema.parse(testCase.scene);
        const computedSpend = computeExpectedNewPurchaseCents(parsedScene);
        assert.equal(
          computedSpend,
          testCase.expected.newPurchaseCents,
          `${testCase.id}: expected.newPurchaseCents must equal non-owned product spend (owned fixtures = $0)`
        );
      }
    }
  );
});

runner.describe(
  'validateScene (lib/constraints.ts) — 8 independent store scenarios',
  () => {
    for (const testCase of evalSuite.cases as EvalCaseRecord[]) {
      const testTitle = `${testCase.id} [${testCase.category}]: ${testCase.title}`;

      if (!constraintsAvailable) {
        runner.todo(
          `[TODO: awaiting lib/constraints.ts#validateScene merge] ${testTitle}`
        );
        continue;
      }

      runner.it(testTitle, async () => {
        const validateScene = await loadValidateScene();
        assert.ok(validateScene, 'validateScene export must exist in lib/constraints.ts');

        const scene = ShopSceneSchema.parse(structuredClone(testCase.scene));
        const result = normalizeValidationOutput(validateScene(scene));

        const actualErrorCodes = uniqueSortedCodes(result.issues, 'error');
        const expectedErrorCodes = [...testCase.expected.errorCodes].sort();

        assert.deepEqual(
          actualErrorCodes,
          expectedErrorCodes,
          `${testCase.id}: mismatch in error codes. Issues: ${JSON.stringify(result.issues)}`
        );
        assert.equal(
          result.valid,
          testCase.expected.valid,
          `${testCase.id}: expected valid=${String(testCase.expected.valid)}`
        );

        const actualWarningCodes = uniqueSortedCodes(result.issues, 'warning');
        for (const expectedWarn of testCase.expected.warningCodes) {
          assert.ok(
            actualWarningCodes.includes(expectedWarn as ConstraintIssueCode),
            `${testCase.id}: expected warning code ${expectedWarn}, got ${JSON.stringify(actualWarningCodes)}`
          );
        }

        if (testCase.expected.warningCodes.length === 0) {
          assert.deepEqual(
            actualWarningCodes,
            [],
            `${testCase.id}: expected zero warnings, got ${JSON.stringify(result.issues)}`
          );
        }

        const errorObjectIds = new Set(
          result.issues
            .filter((i) => i.severity === 'error')
            .flatMap((i) => i.objectIds)
        );
        for (const expectedObjId of testCase.expected.affectedErrorObjectIds) {
          assert.ok(
            errorObjectIds.has(expectedObjId),
            `${testCase.id}: expected error objectIds to include "${expectedObjId}", got ${JSON.stringify([...errorObjectIds])}`
          );
        }

        if ('warningObjectIds' in testCase.expected && Array.isArray(testCase.expected.warningObjectIds)) {
          const warnObjectIds = new Set(
            result.issues
              .filter((i) => i.severity === 'warning')
              .flatMap((i) => i.objectIds)
          );
          for (const expectedWarnId of testCase.expected.warningObjectIds) {
            assert.ok(
              warnObjectIds.has(expectedWarnId),
              `${testCase.id}: expected warning objectIds to include "${expectedWarnId}"`
            );
          }
        }

        if (typeof result.reportedNewPurchaseCents === 'number') {
          assert.equal(
            result.reportedNewPurchaseCents,
            testCase.expected.newPurchaseCents,
            `${testCase.id}: summary.newPurchaseCents must treat owned items as 0 cents`
          );
        }
      });
    }

    if (!constraintsAvailable) {
      runner.todo(
        '[TODO: awaiting lib/constraints.ts#validateScene merge] flags OUT_OF_BOUNDS when a rotated fixture protrudes past the west wall'
      );
      runner.todo(
        '[TODO: awaiting lib/constraints.ts#validateScene merge] flags BLOCKED_PATH when an object blocks the alternate east-wall offset entrance'
      );
      runner.todo(
        '[TODO: awaiting lib/constraints.ts#validateScene merge] validates compactDemoScene (12x10 ft) and flagshipScene (24x18 ft) with zero hard errors'
      );
    } else {
      runner.it(
        'flags OUT_OF_BOUNDS when a rotated fixture protrudes past the west wall',
        async () => {
          const validateScene = await loadValidateScene();
          assert.ok(validateScene);

          const baseCase = ShopSceneSchema.parse(
            structuredClone(evalSuite.cases[0].scene)
          );
          baseCase.objects[1] = {
            ...baseCase.objects[1],
            position: [-1.5, 0, -0.2],
            rotationY: Math.PI / 4,
          };

          const result = normalizeValidationOutput(validateScene(baseCase));
          assert.equal(result.valid, false);
          assert.ok(
            result.issues.some(
              (i) =>
                i.code === 'OUT_OF_BOUNDS' &&
                i.severity === 'error' &&
                i.objectIds.includes(baseCase.objects[1].id)
            )
          );
        }
      );

      runner.it(
        'flags BLOCKED_PATH when an object blocks the alternate east-wall offset entrance',
        async () => {
          const validateScene = await loadValidateScene();
          assert.ok(validateScene);

          const eastEntryScene = ShopSceneSchema.parse(
            structuredClone(evalSuite.cases[7].scene)
          );
          eastEntryScene.objects.push({
            id: 'east-door-blocker',
            kind: 'rack',
            label: 'Misplaced East Doorway Rack',
            source: 'owned',
            position: [1.45, 0, -0.35],
            size: [0.6, 1.6, 0.85],
            rotationY: 0,
            dimensionsVerified: true,
          });

          const result = normalizeValidationOutput(validateScene(eastEntryScene));
          assert.equal(result.valid, false);
          assert.ok(
            result.issues.some(
              (i) => i.code === 'BLOCKED_PATH' && i.severity === 'error'
            )
          );
        }
      );

      runner.it(
        'validates compactDemoScene (12x10 ft) and flagshipScene (24x18 ft) with zero hard errors',
        async () => {
          const validateScene = await loadValidateScene();
          assert.ok(validateScene);

          const compactResult = normalizeValidationOutput(
            validateScene(structuredClone(compactDemoScene))
          );
          const flagshipResult = normalizeValidationOutput(
            validateScene(structuredClone(flagshipScene))
          );

          assert.equal(compactResult.valid, true);
          assert.equal(flagshipResult.valid, true);
          assert.ok(
            compactResult.issues.some(
              (i) => i.code === 'UNVERIFIED_DIMENSIONS' && i.severity === 'warning'
            )
          );
        }
      );
    }
  }
);
