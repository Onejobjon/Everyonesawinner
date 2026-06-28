import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/logout")({
  loader: () => {
    throw redirect({
      href: "/",
      headers: {
        "set-cookie": "mp_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax",
      },
    });
  },
});