import { Logger } from '@nestjs/common';
import { LogThrottle } from './log-throttle';

describe('LogThrottle', () => {
  it('logs a repeated message at most once per window', () => {
    jest.useFakeTimers();
    const logger = { warn: jest.fn() } as unknown as Logger;
    const throttle = new LogThrottle(logger, 60_000);
    throttle.warn('redis down');
    throttle.warn('redis down');
    throttle.warn('lain');
    expect((logger.warn as jest.Mock).mock.calls).toEqual([['redis down'], ['lain']]);
    jest.advanceTimersByTime(60_001);
    throttle.warn('redis down');
    expect(logger.warn).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });
});
