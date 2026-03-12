import { DrizzlePostgreSQLAdapter } from "@lucia-auth/adapter-drizzle";
import { Lucia } from "lucia";
import { db } from "../db/index.js";
import { sessions, users } from "../db/schema/index.js";

// Type assertion: Drizzle schema columns satisfy Lucia adapter expectations at runtime
const adapter = new DrizzlePostgreSQLAdapter(db, sessions as never, users as never);

// HTTP: secure=false so cookies work over plain HTTP. For HTTPS, set COOKIE_SECURE=true in env.
const cookieSecure = String(process.env.COKIE_SECURE ?? "").toLowerCase() === "true";
export const lucia = new Lucia(adapter, {
	sessionCookie: {
		attributes: {
			secure: cookieSecure,
			sameSite: "lax",
			path: "/",
		}
	},
	getUserAttributes: (attributes) => {
		return {
			username: attributes.username,
			email: attributes.email
		};
	}
});

declare module "lucia" {
	interface Register {
		Lucia: typeof lucia;
		DatabaseUserAttributes: DatabaseUserAttributes;
	}
}

interface DatabaseUserAttributes {
	username: string;
	email: string;
}
