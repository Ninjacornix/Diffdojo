#include <vector>
#include "net/request.hpp"

namespace net {

class RetryQueue {
public:
    explicit RetryQueue(int max_retries) : max_retries_(max_retries) {}

private:
    int max_retries_;
};

}  // namespace net
