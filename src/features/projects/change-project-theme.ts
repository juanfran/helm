import type { Theme } from "../../domain/projects";
import { changeTheme } from "../../server/project-functions";
import { applyThemeOptimistically } from "../../styles/theme";

export async function changeProjectTheme(previousTheme: Theme, nextTheme: Theme) {
  await applyThemeOptimistically({
    previousTheme,
    nextTheme,
    persist: async () => {
      const response = await changeTheme({
        data: { theme: nextTheme, idempotencyKey: crypto.randomUUID() },
      });
      if (!response.ok) throw new Error(response.error.message);
    },
  });
}
