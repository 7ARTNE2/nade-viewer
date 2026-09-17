use std::{env, fs::File, io, path::PathBuf, process};

fn usage() -> ! {
    eprintln!("Usage: library-compress --input <path> --output <path> --level <1-22>");
    process::exit(2);
}

fn main() -> io::Result<()> {
    let mut input = None;
    let mut output = None;
    let mut level = 3;
    let mut args = env::args().skip(1);

    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--input" => input = args.next().map(PathBuf::from),
            "--output" => output = args.next().map(PathBuf::from),
            "--level" => {
                level = args
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or_else(|| usage())
            }
            _ => usage(),
        }
    }

    let Some(input) = input else { usage() };
    let Some(output) = output else { usage() };
    let mut source = File::open(input)?;
    let mut destination = File::create(output)?;
    zstd::stream::copy_encode(&mut source, &mut destination, level)?;
    Ok(())
}
