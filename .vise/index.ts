import type { Registry, runCommand } from "..";

export default (reg: Registry) => {
    const profileId = reg.getProfile("Analyze");
    if (!profileId) {
        console.error("No 'Analyze' profile found, skipping hook registration.");
        return;
    }

    const hookId = reg.createHook({
        events: ["subagent:before"],
        handler: () => {
            const output : CommandOutput = runCommand("bun run lint");
            return output.display();
        }
    });

    reg.createConnection(profileId, hookId);
};
