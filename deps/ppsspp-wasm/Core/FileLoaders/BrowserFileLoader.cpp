// Browser-backed game files. Distributed under GPL-2.0-or-later.
#ifdef __EMSCRIPTEN__
#include <algorithm>
#include <limits>
#include <emscripten/threading.h>

#include "Common/Log.h"
#include "Core/FileLoaders/BrowserFileLoader.h"

extern "C" {
double ppsspp_browser_file_size(const char *path);
int ppsspp_browser_has_files();
int ppsspp_browser_read(const char *path, double offset, int bytes, void *destination);
}

bool BrowserFileLoader::SupportsPath(const Path &filename) {
	const std::string &path = filename.ToString();
	return path.size() > 15 && path.compare(0, 15, "/browser-games/") == 0
		&& path.find('/', 15) == std::string::npos;
}

bool BrowserFileLoaderHasFiles() {
	return ppsspp_browser_has_files() != 0;
}

BrowserFileLoader::BrowserFileLoader(const Path &filename)
	: filename_(filename), filesize_((s64)ppsspp_browser_file_size(filename.c_str())) {
}

size_t BrowserFileLoader::ReadAt(s64 absolutePos, size_t bytes, size_t count, void *data, Flags flags) {
	if (!bytes || !count || absolutePos < 0 || absolutePos >= filesize_
		|| count > std::numeric_limits<size_t>::max() / bytes) {
		return 0;
	}
	// Never busy-wait on the UI thread: it must service the async Blob read.
	if (emscripten_is_main_runtime_thread()) {
		ERROR_LOG(Log::FileSystem, "Browser game read attempted on the main thread: %s", filename_.c_str());
		return 0;
	}
	const size_t wanted = (size_t)std::min<u64>(bytes * count, filesize_ - absolutePos);
	size_t completed = 0;
	constexpr size_t MAX_READ = 1024 * 1024;
	while (completed < wanted) {
		const size_t requested = std::min(MAX_READ, wanted - completed);
		const int read = ppsspp_browser_read(filename_.c_str(), (double)(absolutePos + completed),
			(int)requested, (u8 *)data + completed);
		if (read <= 0 || (size_t)read > requested) {
			ERROR_LOG(Log::FileSystem, "Browser game read failed at %lld: %s", (long long)(absolutePos + completed), filename_.c_str());
			break;
		}
		completed += read;
		if ((size_t)read != requested) break;
	}
	return completed / bytes;
}
#endif
