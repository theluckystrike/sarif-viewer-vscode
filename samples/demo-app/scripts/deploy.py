import subprocess, sys

def deploy(target):
    subprocess.call("rsync -a build/ " + target, shell=True)

if __name__ == "__main__":
    deploy(sys.argv[1])
