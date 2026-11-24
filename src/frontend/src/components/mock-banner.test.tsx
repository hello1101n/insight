import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";

import { MockBanner } from "@/components/mock-banner";

// WORKAROUND: vite loads the developer's `.env.local`, so both mock flags are
// stubbed to a known baseline first.
describe("MockBanner", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_ENABLE_MOCKS", "false");
    vi.stubEnv("VITE_HIDE_MOCK_BANNER", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders nothing when mocks are not enabled", () => {
    const { container } = render(<MockBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the synthetic-data warning when mocks are enabled", () => {
    vi.stubEnv("VITE_ENABLE_MOCKS", "true");
    render(<MockBanner />);
    expect(screen.getByText("Synthetic data")).toBeInTheDocument();
  });

  it("stays hidden when the banner is explicitly suppressed", () => {
    vi.stubEnv("VITE_ENABLE_MOCKS", "true");
    vi.stubEnv("VITE_HIDE_MOCK_BANNER", "true");
    const { container } = render(<MockBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});
