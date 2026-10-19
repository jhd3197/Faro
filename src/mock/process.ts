// Mock of @tauri-apps/plugin-process for the demo/headless build. `relaunch`
// just records that it was called so the verify can assert the restart step.
export async function relaunch(): Promise<void> {
  if ((window as any).__mockRelaunchError) throw (window as any).__mockRelaunchError;
  (window as any).__relaunched = true;
}

export async function exit(_code?: number): Promise<void> {
  (window as any).__exited = true;
}
