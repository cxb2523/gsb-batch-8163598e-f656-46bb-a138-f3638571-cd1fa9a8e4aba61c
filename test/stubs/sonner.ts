// The component only needs sonner's call shape in a DOM test; the real toaster is not
// mounted, and asserting on toasts is not what this test is about.
export const toast = Object.assign(
  () => 0,
  {
    success: () => 0,
    error: () => 0,
    warning: () => 0,
    info: () => 0,
  },
);
