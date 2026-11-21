import type { ReactNode } from "react";

export const metadata = {
  title: "SpaceStage",
  description: "Constraint-aware 3D retail store planner powered by Gemini 4",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
