import heapq
from collections import deque, defaultdict


class Scheduler:
    def __init__(self, limit: int):
        self.limit = limit
        self.jobs = []
        self.by_owner = defaultdict(list)
        self.recent = deque(maxlen=10)

    def add(self, when, job, owner):
        heapq.heappush(self.jobs, (when, job))
        self.by_owner[owner].append(job)

    def due(self, now):
        out = []
        while self.jobs and self.jobs[0][0] <= now:
            when, job = heapq.heappop(self.jobs)
            out.append(job)
            self.recent.append(job)
        return out


def clamp(x: int, lo: int, hi: int) -> int:
    if x < lo:
        return lo
    if x > hi:
        return hi
    return x
