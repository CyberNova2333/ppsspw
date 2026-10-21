// Browser-backed game files. Distributed under GPL-2.0-or-later.
#pragma once

#ifdef __EMSCRIPTEN__
#include "Core/Loaders.h"

// Content is read asynchronously on the browser thread while the calling
// emulation pthread waits. No full-disc allocation is made in MEMFS or WASM.
class BrowserFileLoader : public FileLoader {
public:
	explicit BrowserFileLoader(const Path &filename);
	static bool SupportsPath(const Path &filename);
	bool Exists() override { return filesize_ >= 0; }
	bool IsDirectory() override { return false; }
	s64 FileSize() override { return filesize_; }
	Path GetPath() const override { return filename_; }
	size_t ReadAt(s64 absolutePos, size_t bytes, size_t count, void *data, Flags flags = Flags::NONE) override;

private:
	Path filename_;
	s64 filesize_;
};

bool BrowserFileLoaderHasFiles();
#endif
