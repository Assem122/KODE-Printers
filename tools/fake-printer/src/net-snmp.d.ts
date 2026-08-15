/**
 * Ambient types for `net-snmp`, scoped to what the harness uses.
 *
 * The server has its own, wider declaration. Duplicating the two lines needed
 * here is better than making the harness depend on the server package just to
 * borrow a type — the harness must stay importable from a test that has not
 * loaded the application.
 */
declare module 'net-snmp' {
  export interface AgentMib {
    setScalarValue(oid: string, value: unknown): void;
  }

  export interface Agent {
    getMib(): AgentMib;
    getPort?(): number;
    close(): void;
  }

  export function createAgent(
    options: { port?: number; disableAuthorization?: boolean },
    callback: (error: Error | null) => void,
  ): Agent;
}
