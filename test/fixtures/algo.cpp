#include <vector>
#include <string>

int count_above(const std::vector<int>& xs, int limit) {
    int n = 0;
    for (size_t i = 0; i < xs.size(); i++) {
        if (xs[i] > limit) {
            n++;
        }
    }
    return n;
}

std::string repeat_word(const std::string& w, int times) {
    std::string out;
    for (int i = 0; i < times; ++i) out += w;
    return out;
}
