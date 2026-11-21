import { describe, expect, it } from 'vitest';
import evalSuite from '@/fixtures/eval-cases.json';
import { compactDemoScene, flagshipScene } from '@/fixtures/demoScene';
import { evaluateScene, validateScene } from '@/lib/constraints';
import {
  ConstraintIssueSchema,
  FT_TO_METERS,
  ShopSceneSchema,
  type ConstraintIssue,
  type ConstraintIssueCode,
  type ShopScene,
} from '@/lib/schema';

type EvalCaseRecord = (typeof evalSuite.cases)[number];

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

describe('SpaceStage evaluation fixtures & shared schema contract', () => {
  it('defines all 8 required independent small-store scenarios with unique IDs', () => {
    expect(evalSuite.cases).toHaveLength(8);

    const ids = evalSuite.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(8);

    const categories = evalSuite.cases.map((c) => c.category);
    expect(categories).toEqual([...REQUIRED_CATEGORIES]);
  });

  it('validates every eval scenario and demo preset against ShopSceneSchema in meters', () => {
    expect(FT_TO_METERS).toBe(0.3048);

    const parsedCompact = ShopSceneSchema.parse(compactDemoScene);
    const parsedFlagship = ShopSceneSchema.parse(flagshipScene);
    expect(parsedCompact.room.width).toBeGreaterThan(3.6);
    expect(parsedCompact.room.width).toBeLessThan(3.7);
    expect(parsedFlagship.room.width).toBeGreaterThan(7.3);
    expect(parsedFlagship.room.width).toBeLessThan(7.4);

    for (const testCase of evalSuite.cases) {
      const parsedScene = ShopSceneSchema.parse(testCase.scene);
      const computedSpend = computeExpectedNewPurchaseCents(parsedScene);
      expect(computedSpend).toBe(testCase.expected.newPurchaseCents);
    }
  });
});

describe('validateScene (lib/constraints.ts) — 8 independent store scenarios', () => {
  for (const testCase of evalSuite.cases as EvalCaseRecord[]) {
    it(`${testCase.id} [${testCase.category}]: ${testCase.title}`, () => {
      const scene = ShopSceneSchema.parse(structuredClone(testCase.scene));
      const issues = validateScene(scene);
      const detailed = evaluateScene(scene);

      for (const issue of issues) {
        ConstraintIssueSchema.parse(issue);
      }

      const hasError = issues.some((i) => i.severity === 'error');
      const actualErrorCodes = uniqueSortedCodes(issues, 'error');
      const expectedErrorCodes = [...testCase.expected.errorCodes].sort();

      expect(actualErrorCodes).toEqual(expectedErrorCodes);
      expect(!hasError).toBe(testCase.expected.valid);
      expect(detailed.valid).toBe(testCase.expected.valid);
      expect(detailed.summary.newPurchaseCents).toBe(
        testCase.expected.newPurchaseCents
      );

      const actualWarningCodes = uniqueSortedCodes(issues, 'warning');
      for (const expectedWarn of testCase.expected.warningCodes) {
        expect(actualWarningCodes).toContain(expectedWarn);
      }

      if (testCase.expected.warningCodes.length === 0) {
        expect(actualWarningCodes).toEqual([]);
      }

      const errorObjectIds = new Set(
        issues.filter((i) => i.severity === 'error').flatMap((i) => i.objectIds)
      );
      for (const expectedObjId of testCase.expected.affectedErrorObjectIds) {
        expect(errorObjectIds.has(expectedObjId)).toBe(true);
      }

      if (
        'warningObjectIds' in testCase.expected &&
        Array.isArray(testCase.expected.warningObjectIds)
      ) {
        const warnObjectIds = new Set(
          issues
            .filter((i) => i.severity === 'warning')
            .flatMap((i) => i.objectIds)
        );
        for (const expectedWarnId of testCase.expected.warningObjectIds) {
          expect(warnObjectIds.has(expectedWarnId)).toBe(true);
        }
      }
    });
  }

  it('flags OUT_OF_BOUNDS when a rotated fixture protrudes past the west wall', () => {
    const baseCase = ShopSceneSchema.parse(
      structuredClone(evalSuite.cases[0].scene)
    );
    baseCase.objects[1] = {
      ...baseCase.objects[1],
      position: [-1.5, 0, -0.2],
      rotationY: Math.PI / 4,
    };

    const issues = validateScene(baseCase);
    expect(
      issues.some(
        (i) =>
          i.code === 'OUT_OF_BOUNDS' &&
          i.severity === 'error' &&
          i.objectIds.includes(baseCase.objects[1].id)
      )
    ).toBe(true);
  });

  it('flags BLOCKED_PATH when an object blocks the alternate east-wall offset entrance', () => {
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

    const issues = validateScene(eastEntryScene);
    expect(
      issues.some((i) => i.code === 'BLOCKED_PATH' && i.severity === 'error')
    ).toBe(true);
  });

  it('validates compactDemoScene (12x10 ft) and flagshipScene (24x18 ft) with zero hard errors', () => {
    const compactIssues = validateScene(structuredClone(compactDemoScene));
    const flagshipIssues = validateScene(structuredClone(flagshipScene));

    expect(compactIssues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(flagshipIssues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(
      compactIssues.some(
        (i) => i.code === 'UNVERIFIED_DIMENSIONS' && i.severity === 'warning'
      )
    ).toBe(true);
  });
});
