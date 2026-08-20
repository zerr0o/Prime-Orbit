import { useCallback, useEffect, useRef, useState } from "react";
import packageMetadata from "../../package.json";
import {
  checkForAppUpdates,
  downloadAppUpdate,
  getAppUpdateState,
  installAppUpdate,
  isNative,
  listenToAppUpdateState,
} from "../lib/bridge";
import {
  beginAppUpdateCheck,
  beginAppUpdateDownload,
  beginAppUpdateInstall,
  failAppUpdateOperation,
  normalizeAppUpdateState,
  preferNewestAppUpdateState,
  resolveInitialAppUpdateState,
  shouldRunAutomaticUpdateCheck,
} from "../lib/app-updater";
import { redactText } from "../lib/redaction";
import type { AppUpdateInstallResult, AppUpdateState } from "../types";

const AUTOMATIC_CHECK_DELAY_MS = 5_000;

function updaterError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message).slice(0, 4_000);
}

export function useAppUpdater({ automaticChecks }: { automaticChecks: boolean }) {
  const [state, setReactState] = useState<AppUpdateState>({
    revision: 0,
    phase: "idle",
    currentVersion: packageMetadata.version,
  });
  const [initialized, setInitialized] = useState(false);
  const stateRef = useRef(state);
  const operationRef = useRef<"check" | "download" | "install" | undefined>(undefined);
  const automaticCheckAttempted = useRef(false);

  const setState = useCallback((next: AppUpdateState) => {
    const accepted = preferNewestAppUpdateState(stateRef.current, next);
    if (accepted === stateRef.current) return false;
    stateRef.current = accepted;
    setReactState(accepted);
    return true;
  }, []);

  useEffect(() => {
    let active = true;
    let subscribed = false;
    let queuedEvent: AppUpdateState | undefined;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        unlisten = await listenToAppUpdateState((snapshot) => {
          if (!active) return;
          const normalized = normalizeAppUpdateState(snapshot, stateRef.current.currentVersion);
          if (!subscribed) {
            queuedEvent = queuedEvent
              ? preferNewestAppUpdateState(queuedEvent, normalized)
              : normalized;
            return;
          }
          setState(normalized);
        });
      } catch {
        // A direct snapshot remains useful if event subscription is temporarily unavailable.
      }
      if (!active) {
        unlisten?.();
        return;
      }

      try {
        const snapshot = await getAppUpdateState();
        if (!active) return;
        setState(resolveInitialAppUpdateState(snapshot, queuedEvent, packageMetadata.version));
      } catch (error) {
        if (!active) return;
        const failed = failAppUpdateOperation(stateRef.current, "check", updaterError(error));
        setState(resolveInitialAppUpdateState(failed, queuedEvent, packageMetadata.version));
      } finally {
        if (active) {
          subscribed = true;
          setInitialized(true);
        }
      }
    })();

    return () => {
      active = false;
      unlisten?.();
    };
  }, [setState]);

  const check = useCallback(async (trigger: "automatic" | "manual" = "manual") => {
    if (operationRef.current) return undefined;
    operationRef.current = "check";
    const optimistic = beginAppUpdateCheck(stateRef.current, trigger);
    setState(optimistic);
    try {
      const snapshot = normalizeAppUpdateState(await checkForAppUpdates(trigger), stateRef.current.currentVersion);
      setState(snapshot);
      return snapshot;
    } catch (error) {
      const failed = failAppUpdateOperation(optimistic, "check", updaterError(error));
      setState(failed);
      return failed;
    } finally {
      operationRef.current = undefined;
    }
  }, [setState]);

  const download = useCallback(async () => {
    const current = stateRef.current;
    if (operationRef.current || !current.update || (current.phase !== "available" && !(current.phase === "error" && current.operation === "download"))) return undefined;
    operationRef.current = "download";
    const optimistic = beginAppUpdateDownload(current);
    setState(optimistic);
    try {
      const snapshot = normalizeAppUpdateState(await downloadAppUpdate(), stateRef.current.currentVersion);
      setState(snapshot);
      return snapshot;
    } catch (error) {
      const failed = failAppUpdateOperation(optimistic, "download", updaterError(error));
      setState(failed);
      return failed;
    } finally {
      operationRef.current = undefined;
    }
  }, [setState]);

  const install = useCallback(async (force = false): Promise<AppUpdateInstallResult | undefined> => {
    const current = stateRef.current;
    if (operationRef.current || !current.update || (current.phase !== "ready" && !(current.phase === "error" && current.operation === "install"))) return undefined;
    operationRef.current = "install";
    const optimistic = beginAppUpdateInstall(current);
    try {
      const result = await installAppUpdate(force);
      if (result.status === "installing") setState(optimistic);
      return result;
    } catch (error) {
      setState(failAppUpdateOperation(optimistic, "install", updaterError(error)));
      return undefined;
    } finally {
      operationRef.current = undefined;
    }
  }, [setState]);

  useEffect(() => {
    if (!shouldRunAutomaticUpdateCheck({
      enabled: automaticChecks,
      initialized,
      attempted: automaticCheckAttempted.current,
      native: isNative(),
    })) return;
    const timer = window.setTimeout(() => {
      automaticCheckAttempted.current = true;
      void check("automatic");
    }, AUTOMATIC_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [automaticChecks, check, initialized]);

  return { state, initialized, check, download, install };
}
