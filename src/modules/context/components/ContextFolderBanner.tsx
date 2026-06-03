import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { contextApi } from "@/modules/context/api";
import { useContextChangeListener } from "@/modules/context/eventBus";
import { isMissingFolderError } from "./availability";
import styles from "./ContextFolderBanner.module.css";

type FolderAvailability = "unknown" | "available" | "missing";

function useFolderAvailability(
  connectionId: string,
  contextPath: string | null,
): FolderAvailability {
  const [availability, setAvailability] = useState<FolderAvailability>("unknown");

  const check = useCallback(() => {
    if (!contextPath) {
      setAvailability("unknown");
      return;
    }
    contextApi
      .listObjects(connectionId)
      .then(() => setAvailability("available"))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (isMissingFolderError(msg)) {
          setAvailability("missing");
        } else {
          // Other errors (permissions, etc.) — don't show the banner
          setAvailability("available");
        }
      });
  }, [connectionId, contextPath]);

  useEffect(() => {
    check();
  }, [check]);

  useContextChangeListener(contextPath, "all", check);

  return availability;
}

interface BannerProps {
  connectionId: string;
  contextPath: string | null;
}

export function ContextFolderBanner({
  connectionId,
  contextPath,
}: BannerProps): JSX.Element | null {
  const availability = useFolderAvailability(connectionId, contextPath);
  if (availability !== "missing" || !contextPath) return null;
  return (
    <div className={styles.banner}>
      <AlertTriangle size={12} strokeWidth={1.6} />
      <span className={styles.path}>{contextPath}</span>
      <span className={styles.hint}>not found on disk</span>
    </div>
  );
}
