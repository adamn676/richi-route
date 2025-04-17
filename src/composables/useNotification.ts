// src/composables/useNotification.ts
import { useToast } from "primevue/usetoast";

/**
 * Provides success, error, info, and warn notification methods.
 */
export function useNotification() {
  const toast = useToast();
  return {
    success: (msg: string) =>
      toast.add({
        severity: "success",
        summary: "Success",
        detail: msg,
        life: 3000,
      }),
    error: (msg: string) =>
      toast.add({
        severity: "error",
        summary: "Error",
        detail: msg,
        life: 5000,
      }),
    info: (msg: string) =>
      toast.add({ severity: "info", summary: "Info", detail: msg, life: 3000 }),
    warn: (msg: string) =>
      toast.add({
        severity: "warn",
        summary: "Warning",
        detail: msg,
        life: 4000,
      }),
  };
}
