set -xe

IMAGE=node:slim

podman run \
	--rm -it \
	-v ./:/work_dir \
	-w /work_dir \
	--entrypoint '/bin/bash' \
	$IMAGE \
	-c '
		pnpm install
		pnpm run build
	'
