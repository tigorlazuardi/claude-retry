export interface AbsoluteTime {
    hour: number;
    minute: number;
    timezone: string | null;
    ambiguous: boolean;
}
export interface RelativeTime {
    relative: true;
    waitMs: number;
}
export type ParsedTime = AbsoluteTime | RelativeTime | null;
export declare function parseResetTime(text: string): ParsedTime;
export declare function calculateWaitMs(parsed: ParsedTime, marginSeconds?: number, fallbackHours?: number, now?: Date): number;
//# sourceMappingURL=time-parser.d.ts.map