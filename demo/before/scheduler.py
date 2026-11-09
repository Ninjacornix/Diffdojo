class Scheduler:
    def __init__(self, limit: int):
        self.limit = limit
        self.jobs = []

    def add(self, when, job, owner):
        self.jobs.append((when, job))
