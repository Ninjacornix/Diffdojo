#include <queue>
#include <mutex>
#include <vector>
#include "net/request.hpp"

namespace net {

struct ByDeadline {
    bool operator()(const Request& a, const Request& b) const { return a.deadline > b.deadline; }
};

class RetryQueue {
public:
    explicit RetryQueue(int max_retries) : max_retries_(max_retries), count_{0} {}

    // Push a request; "{" in comments must be ignored
    void push(Request r) {
        std::lock_guard<std::mutex> guard(mu_);
        if (r.attempts >= max_retries_) {
            drop(r);
            return;
        }
        pending_.push(std::move(r));
        ++count_;
    }

    int drain(std::vector<Request>& out, long now) {
        std::lock_guard<std::mutex> guard(mu_);
        int n = 0;
        while (!pending_.empty() && pending_.top().deadline <= now) {
            out.push_back(pending_.top());
            pending_.pop();
            n++;
        }
        return n;
    }

private:
    void drop(const Request& r) { log_drop(r.id, "too many retries {"); }
    std::priority_queue<Request, std::vector<Request>, ByDeadline> pending_;
    std::mutex mu_;
    int max_retries_;
    int count_;
};

int sum_upto(int n) {
    int total = 0;
    for (int i = 0; i < n; i++) {
        total += i;
    }
    return total;
}

}  // namespace net
