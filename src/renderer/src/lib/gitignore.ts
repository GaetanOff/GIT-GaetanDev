/**
 * A file name as a .gitignore pattern that matches it alone: "[", "*", "?" and "\" are pattern
 * characters ("data[1].csv" ignored data1.csv and not itself), a leading "#" or "!" changes the
 * line's meaning, and trailing spaces are dropped by git unless escaped.
 */
export function ignoreLiteral(name: string): string {
  return name.replace(/[[\]*?\\]/g, '\\$&').replace(/^[#!]/, '\\$&').replace(/ +$/, s => s.replace(/ /g, '\\ '))
}
