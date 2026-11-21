import { useCallback, useRef } from "react";
import {
  matchesElementContent,
  snapshotElementContent,
} from "../../utils/sync";

type ElementVersionInfo = {
  version: number;
  versionNonce: number;
  updated: number;
  content: ReturnType<typeof snapshotElementContent>;
};

const getUpdated = (element: any): number =>
  typeof element.updated === "number"
    ? element.updated
    : Number(element.updated) || 0;

export const useEditorElementTracking = () => {
  const elementVersionMap = useRef<Map<string, ElementVersionInfo>>(new Map());
  // Bumped on every recorded version (local broadcast, remote merge, scene
  // load), so the broadcast fast path knows when the baseline moved.
  const trackingEpochRef = useRef(0);

  const recordElementVersion = useCallback((element: any) => {
    trackingEpochRef.current += 1;
    elementVersionMap.current.set(element.id, {
      version: element.version ?? 0,
      versionNonce: element.versionNonce ?? 0,
      updated: getUpdated(element),
      content: snapshotElementContent(element),
    });
  }, []);

  const hasElementChanged = useCallback((element: any, status?: unknown) => {
    const previous = elementVersionMap.current.get(element.id);
    return (
      !previous ||
      previous.version !== (element.version ?? 0) ||
      previous.versionNonce !== (element.versionNonce ?? 0) ||
      previous.updated !== getUpdated(element) ||
      !matchesElementContent(previous.content, element, status)
    );
  }, []);

  // Cheap, order-sensitive fingerprint of the scene: numbers only, no string
  // building per element. Every local edit in Excalidraw bumps `version` and
  // re-rolls `versionNonce`, so an unchanged fingerprint means no element
  // changed (e.g. only cursors, selection or viewport moved).
  const computeElementsFingerprint = useCallback(
    (elements: readonly any[]) => {
      let hash = 2166136261;
      let count = 0;
      for (const el of elements) {
        if (!el) continue;
        count += 1;
        hash ^= Number(el.version) || 0;
        hash = Math.imul(hash, 16777619);
        hash ^= Number(el.versionNonce) || 0;
        hash = Math.imul(hash, 16777619);
        hash ^= (el.isDeleted ? 1 : 0) | ((el.status?.length ?? 0) << 1);
        hash = Math.imul(hash, 16777619);
      }
      return `${count}:${(hash >>> 0).toString(16)}`;
    },
    [],
  );

  return {
    computeElementsFingerprint,
    trackingEpochRef,
    elementVersionMap,
    hasElementChanged,
    recordElementVersion,
  };
};
